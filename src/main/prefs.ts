// Non-secret preferences in userData/settings.json. Currently just the
// shortcut toggles; unknown ids fall back to the shared defaults.
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultKeybinds } from '../shared/keybinds'

export type KeybindMap = Record<string, boolean>

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function readAll(): Promise<{ keybinds?: KeybindMap }> {
  try {
    return JSON.parse(await readFile(filePath(), 'utf8')) as { keybinds?: KeybindMap }
  } catch {
    return {}
  }
}

export async function getKeybinds(): Promise<KeybindMap> {
  const stored = (await readAll()).keybinds ?? {}
  return { ...defaultKeybinds(), ...stored }
}

export async function setKeybind(id: string, on: boolean): Promise<KeybindMap> {
  const all = await readAll()
  const keybinds = { ...(all.keybinds ?? {}), [id]: on }
  await mkdir(dirname(filePath()), { recursive: true })
  await writeFile(filePath(), JSON.stringify({ ...all, keybinds }, null, 2), 'utf8')
  return getKeybinds()
}
