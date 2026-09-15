// Persistent, resizable, plain-text floating sticky notes — separate from the vault.
// State (text + window bounds) lives in userData/stickies.json so stickies survive
// quit/relaunch. Each window loads sticky.html?id=<id> and pulls its text via sticky:get.
import { BrowserWindow, app, screen, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { loadRenderer, sharedWebPreferences } from './windows'

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface StickyData {
  text: string
  bounds?: Bounds
}

let store: Record<string, StickyData> = {}
const windows = new Map<string, BrowserWindow>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
// Stickies share the quick-capture overlay's visibility — they appear together via
// ⌘⇧Space and tuck away together when it closes. A sticky is a quick-note that
// outlives a single capture; presenting them as one surface keeps the model simple.
let stickiesShouldBeVisible = false

function storePath(): string {
  return join(app.getPath('userData'), 'stickies.json')
}

async function persist(): Promise<void> {
  try {
    await writeFile(storePath(), JSON.stringify(store), 'utf8')
  } catch (err) {
    console.error('[stickies] save failed:', err)
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persist(), 300)
}

// Write the store synchronously, flushing any pending debounced save. Called on quit,
// where an async writeFile is not guaranteed to finish before the process exits.
export function flushStickies(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    writeFileSync(storePath(), JSON.stringify(store), 'utf8')
  } catch (err) {
    console.error('[stickies] flush failed:', err)
  }
}

// If saved bounds don't intersect any current display (e.g. an external monitor was
// unplugged), drop x/y so the OS places the window on-screen — a frameless, taskbar-less
// sticky stranded off-screen is otherwise unrecoverable.
function visibleBounds(bounds?: Bounds): Bounds | undefined {
  if (!bounds || bounds.x == null || bounds.y == null) return bounds
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      bounds.x! < wa.x + wa.width &&
      bounds.x! + bounds.width > wa.x &&
      bounds.y! < wa.y + wa.height &&
      bounds.y! + bounds.height > wa.y
    )
  })
  return onScreen ? bounds : { width: bounds.width, height: bounds.height }
}

// `focus`: bring the new window to the front (used for user-initiated creates so the
// sticky lands above the overlay/parent sticky that spawned it). Restored stickies on
// launch pass false to avoid stealing focus from whatever the user is doing.
function spawnWindow(id: string, savedBounds?: Bounds, focus = false): BrowserWindow {
  const bounds = visibleBounds(savedBounds)
  const win = new BrowserWindow({
    width: bounds?.width ?? 260,
    height: bounds?.height ?? 240,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 160,
    minHeight: 120,
    // type:'panel' (non-activating NSPanel) — clicking a sticky to edit it should
    // not activate the memry app and surface the main editor window.
    type: 'panel',
    frame: false,
    resizable: true,
    fullscreenable: false,
    show: false,
    title: 'Sticky',
    // Match the renderer's actual body color (--sticky = #ffffff). If these mismatch
    // the window background paints briefly during open/close teardown, which reads
    // as a "yellow flash" when the renderer's white DOM is gone but the window is
    // not yet hidden.
    backgroundColor: '#ffffff',
    webPreferences: sharedWebPreferences
  })

  // Drop float-above on hide so a hidden window never suppresses the macOS
  // auto-hide menu bar. The all-workspaces flag is deliberately left alone:
  // changing Space membership during a hide can pull the user to another Space.
  win.on('hide', () => {
    win.setAlwaysOnTop(false)
  })

  win.once('ready-to-show', () => {
    if (!stickiesShouldBeVisible) return
    // Float on the current Space. Set before showing so macOS does not move
    // the user to another Space to reveal the window.
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // Without this, Electron transforms the process type between
      // ForegroundApplication and UIElementApplication on every call. An
      // accessory app cannot be frontmost, so macOS hands the front to another
      // app and Memry appears to vanish. The transform is asynchronous, which is
      // why the app still reads as active on the very next line and only flips a
      // few tens of milliseconds later. Electron's own docs: "this will hide the
      // window and dock for a short time every time it is called."
      skipTransformProcessType: true
    })
    if (!focus) {
      win.showInactive()
      return
    }
    // The overlay and sibling stickies all sit at alwaysOnTop level 'floating'.
    // Within one level, a freshly shown window does not reliably land above the
    // one that just had the click, so bump the new sticky a level higher for its
    // debut, then drop back on first blur. showInactive keeps the main window
    // and the previous app exactly where they were.
    win.showInactive()
    win.setAlwaysOnTop(true, 'pop-up-menu')
    win.moveTop()
    win.focus()
    win.once('blur', () => {
      if (!win.isDestroyed() && win.isVisible()) {
        win.setAlwaysOnTop(true, 'floating')
      }
    })
  })

  const saveBounds = (): void => {
    const entry = store[id]
    if (!entry) return
    entry.bounds = win.getBounds()
    scheduleSave()
  }
  win.on('move', saveBounds)
  win.on('resize', saveBounds)
  win.on('closed', () => windows.delete(id))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'sticky.html', `id=${id}`)
  windows.set(id, win)
  return win
}

// Recreate every saved sticky on launch (called from app.whenReady).
export async function restoreStickies(): Promise<void> {
  let parsed: Record<string, StickyData> = {}
  try {
    parsed = JSON.parse(await readFile(storePath(), 'utf8'))
  } catch {
    parsed = {}
  }
  // Merge in place, never reassign `store`: a sticky created during this async load
  // (overlay "Keep as sticky") would otherwise be discarded by a wholesale replace.
  for (const [id, data] of Object.entries(parsed)) {
    if (!store[id]) store[id] = data
    if (!windows.has(id)) spawnWindow(id, store[id].bounds)
  }
}

// `anchor` lets the caller place a freshly spawned sticky next to its sibling instead
// of stacked directly on top — used by the renderer's "+" button. Always shown with
// focus so the new sticky surfaces above the overlay/parent sticky that triggered it.
export function createSticky(text = '', anchor?: { x: number; y: number }): string {
  const id = randomUUID()
  const bounds: Bounds | undefined = anchor
    ? { x: anchor.x, y: anchor.y, width: 260, height: 240 }
    : undefined
  store[id] = { text, bounds }
  scheduleSave()
  spawnWindow(id, bounds, true)
  return id
}

export function getStickyText(id: string): string {
  return store[id]?.text ?? ''
}

export function updateSticky(id: string, text: string): void {
  const entry = store[id]
  if (!entry) return
  entry.text = text
  scheduleSave()
}

export function setStickiesVisible(visible: boolean): void {
  stickiesShouldBeVisible = visible
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue
    if (visible && !win.isVisible()) {
      // Set BEFORE showing so the window lands on the current Space instead of
      // pulling the user to the Space where the main window sits. showInactive
      // never activates Memry and never hides anything else.
      win.setAlwaysOnTop(true, 'floating')
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        // Without this, Electron transforms the process type between
        // ForegroundApplication and UIElementApplication on every call. An
        // accessory app cannot be frontmost, so macOS hands the front to another
        // app and Memry appears to vanish. The transform is asynchronous, which is
        // why the app still reads as active on the very next line and only flips a
        // few tens of milliseconds later. Electron's own docs: "this will hide the
        // window and dock for a short time every time it is called."
        skipTransformProcessType: true
      })
      win.showInactive()
    } else if (!visible && win.isVisible()) {
      win.hide()
    }
  }
}

export function closeSticky(id: string): void {
  delete store[id]
  scheduleSave()
  const win = windows.get(id)
  if (win && !win.isDestroyed()) {
    // hide() is instant — skips the close-animation moment where the renderer
    // tears down but the yellow window backgroundColor is still on-screen
    // (the "yellow flash" the user sees). destroy() then frees the window.
    win.hide()
    win.destroy()
  }
  windows.delete(id)
}
