// Per-Mac API keys. The installer never ships secrets: on first launch the
// user pastes keys into Settings and they are stored under userData, encrypted
// with the login Keychain via safeStorage when available (plaintext fallback
// otherwise). Loaded at startup; anything already in the environment wins.
import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface UserKeys {
  openaiApiKey: string
  groqApiKey: string
}

interface StoredValue {
  enc: boolean
  data: string
}

type StoredFile = Partial<Record<keyof UserKeys, StoredValue>>

function filePath(): string {
  return join(app.getPath('userData'), 'keys.json')
}

async function protect(plain: string): Promise<StoredValue> {
  if (plain && safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(plain).toString('base64') }
  }
  return { enc: false, data: plain }
}

async function unprotect(v: StoredValue | undefined): Promise<string> {
  if (!v?.data) return ''
  if (!v.enc) return v.data
  try {
    return safeStorage.decryptString(Buffer.from(v.data, 'base64'))
  } catch (err) {
    console.error('[keys] decrypt failed:', err)
    return ''
  }
}

async function readStored(): Promise<StoredFile> {
  try {
    return JSON.parse(await readFile(filePath(), 'utf8')) as StoredFile
  } catch {
    return {}
  }
}

export async function loadUserKeys(): Promise<void> {
  const stored = await readStored()
  const openai = await unprotect(stored.openaiApiKey)
  const groq = await unprotect(stored.groqApiKey)
  if (!process.env.OPENAI_API_KEY && openai) process.env.OPENAI_API_KEY = openai
  if (!process.env.GROQ_API_KEY && groq) process.env.GROQ_API_KEY = groq
}

export async function getUserKeys(): Promise<UserKeys> {
  const stored = await readStored()
  return {
    openaiApiKey: await unprotect(stored.openaiApiKey),
    groqApiKey: await unprotect(stored.groqApiKey)
  }
}

export async function saveUserKeys(keys: UserKeys): Promise<void> {
  const stored: StoredFile = {
    openaiApiKey: await protect(keys.openaiApiKey.trim()),
    groqApiKey: await protect(keys.groqApiKey.trim())
  }
  await mkdir(dirname(filePath()), { recursive: true })
  await writeFile(filePath(), JSON.stringify(stored), 'utf8')
}
