import { app } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { CreateNote, TreeFolder, TreeNote, VaultTree } from '../shared/ipc'

// Vault root: a tree of folders + .md notes. Defaults to ~/Documents/Memry, overridable via vault:pick.
// Ids are vault-relative POSIX paths (e.g. "Folder/Sub/Note.md"); folders are addressed the same way.
let vaultPath = join(app.getPath('documents'), 'Memry')

// Quick notes (and the overlay capture) live in their own reserved top-level folder.
const QUICK_FOLDER = 'Quick Notes'

export function getVaultPath(): string {
  return vaultPath
}

export function setVaultPath(p: string): void {
  vaultPath = p
}

// THE chokepoint for path handling: turn a vault-relative POSIX path into an absolute
// fs path, refusing anything that escapes the vault root (defends every read/write/move).
function safeJoin(rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = resolve(vaultPath, ...clean.split('/').filter(Boolean))
  const root = resolve(vaultPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Path escapes vault: ${rel}`)
  }
  return abs
}

// Like safeJoin, but also resolves symlinks and re-checks containment — so a symlink
// planted inside a synced vault can't redirect a read/write/asset to a file outside it.
// Used for the operations that follow links (read/write/serve); creation stays lexical.
function realJoin(rel: string): string {
  const abs = safeJoin(rel)
  try {
    const real = realpathSync(abs)
    const root = realpathSync(vaultPath)
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`Path escapes vault: ${rel}`)
    }
  } catch (err) {
    // ENOENT = doesn't exist yet (e.g. a brand-new note); the lexical check still holds.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return abs
}

async function ensureRoot(): Promise<void> {
  await mkdir(vaultPath, { recursive: true })
}

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(safeJoin(rel))
    return true
  } catch {
    return false
  }
}

// A non-colliding vault-relative path for `name` inside `folder`, appending
// " 2", " 3", ... before the extension as needed. Shared by create + move.
async function uniqueChild(folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let i = 2
  while (await exists(folder ? `${folder}/${candidate}` : candidate)) {
    candidate = `${stem} ${i}${ext}`
    i++
  }
  return folder ? `${folder}/${candidate}` : candidate
}

function noteMeta(id: string, mtimeMs: number): TreeNote {
  return {
    id,
    title: id.split('/').pop()!.replace(/\.md$/i, ''),
    mtime: mtimeMs,
    quick: id.startsWith(`${QUICK_FOLDER}/`)
  }
}

async function readFolder(rel: string): Promise<TreeFolder> {
  const abs = rel === '' ? resolve(vaultPath) : safeJoin(rel)
  const entries = await readdir(abs, { withFileTypes: true })
  const folders: TreeFolder[] = []
  const notes: TreeNote[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isSymbolicLink()) continue // never surface symlinks (escape vector + ambiguous nesting)
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      folders.push(await readFolder(childRel))
    } else if (e.name.toLowerCase().endsWith('.md')) {
      const s = await stat(join(abs, e.name))
      notes.push(noteMeta(childRel, s.mtimeMs))
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  notes.sort((a, b) => b.mtime - a.mtime)
  return { name: rel === '' ? '' : rel.split('/').pop()!, path: rel, folders, notes }
}

export async function readVaultTree(): Promise<VaultTree> {
  await ensureRoot()
  // Keep the Quick Notes folder present so it always shows in the tree.
  await mkdir(safeJoin(QUICK_FOLDER), { recursive: true })
  return { root: await readFolder('') }
}

export async function readNote(id: string): Promise<string> {
  return readFile(realJoin(id), 'utf8')
}

export async function updateNote(id: string, md: string): Promise<void> {
  await ensureRoot()
  await writeFile(realJoin(id), md, 'utf8')
}

export async function createNote(n: CreateNote): Promise<TreeNote> {
  await ensureRoot()
  const folder = n.quick ? QUICK_FOLDER : (n.folder ?? '')
  if (folder) await mkdir(safeJoin(folder), { recursive: true })
  const base =
    (n.title?.trim() || 'Untitled').replace(/[/\\]/g, '-').replace(/^\.+/, '').trim() || 'Untitled'
  const fileName = base.toLowerCase().endsWith('.md') ? base : `${base}.md`
  const id = await uniqueChild(folder, fileName)
  await writeFile(safeJoin(id), n.body ?? '', 'utf8')
  const s = await stat(safeJoin(id))
  return noteMeta(id, s.mtimeMs)
}

// A quick note from the overlay is a timestamped .md inside the Quick Notes folder.
export async function createQuickNote(text: string): Promise<TreeNote> {
  await mkdir(safeJoin(QUICK_FOLDER), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${QUICK_FOLDER}/quick-${stamp}.md`
  await writeFile(safeJoin(id), text, 'utf8')
  const s = await stat(safeJoin(id))
  return noteMeta(id, s.mtimeMs)
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  await ensureRoot()
  const clean =
    name.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').trim() || 'New Folder'
  const id = await uniqueChild(parentPath, clean)
  await mkdir(safeJoin(id), { recursive: true })
  return id
}

// Rename and move are the same fs.rename; covers notes and folders. Rejects moving a
// folder into its own descendant and de-dupes name collisions at the destination.
export async function moveItem(src: string, dest: string): Promise<string> {
  const srcAbs = safeJoin(src)
  const destAbs = safeJoin(dest)
  if (destAbs === srcAbs) return src
  if (destAbs.startsWith(srcAbs + sep)) {
    throw new Error('Cannot move a folder into itself')
  }
  const destDir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : ''
  const destName = dest.includes('/') ? dest.slice(dest.lastIndexOf('/') + 1) : dest
  // On case-insensitive filesystems (default macOS/Windows) a case-only rename
  // (Note.md -> note.md) resolves to the SAME file; don't treat it as a collision,
  // or uniqueChild would append a spurious " 2".
  const caseOnly =
    (process.platform === 'darwin' || process.platform === 'win32') &&
    destAbs.toLowerCase() === srcAbs.toLowerCase()
  const finalRel = !caseOnly && (await exists(dest)) ? await uniqueChild(destDir, destName) : dest
  await mkdir(dirname(safeJoin(finalRel)), { recursive: true })
  await rename(srcAbs, safeJoin(finalRel))
  return finalRel
}

export async function deleteItem(path: string): Promise<void> {
  await rm(safeJoin(path), { recursive: true, force: true })
}

// Absolute path under the vault for an asset referenced by a memry:// URL.
export function resolveAsset(rel: string): string {
  return realJoin(rel)
}

// Save a pasted/dropped image (or other asset) at the vault root with a collision-
// safe filename. base64 is the raw bytes (no data: prefix); returns the final
// vault-relative path the renderer should insert into the markdown.
export async function writeAsset(filename: string, base64: string): Promise<string> {
  await ensureRoot()
  // Strip path separators, leading dots, and characters that are illegal/awkward on
  // common filesystems. Fall back to a generic name if nothing usable remains.
  const cleaned =
    filename.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+/, '').trim() || 'asset'
  const id = await uniqueChild('', cleaned)
  const buf = Buffer.from(base64, 'base64')
  await writeFile(safeJoin(id), buf)
  return id
}
