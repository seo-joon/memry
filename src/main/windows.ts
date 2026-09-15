import { BrowserWindow, app, shell, globalShortcut, screen, Notification, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setStickiesVisible } from './stickies'
import { CH } from '../shared/ipc'

const PRELOAD = join(__dirname, '../preload/index.js')
const isDev = !!process.env.ELECTRON_RENDERER_URL

export const sharedWebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false
}

let overlayWindow: BrowserWindow | null = null
// Every editor window, so the shortcut can tell when Memry fills the screen.
const editorWindows = new Set<BrowserWindow>()

// ⌘W is intercepted in main (the default menu would close the window), so its
// toggle lives here as a plain flag. Off means the keypress falls through to
// the system default (close window), same as any untaken shortcut.
let closeTabEnabled = true

export function setCloseTabEnabled(on: boolean): void {
  closeTabEnabled = on
}

// Load a renderer HTML entry, dev (vite server) or prod (file), with an optional
// query string (e.g. "id=abc" for a sticky to learn which note it is). Exported so
// stickies.ts can spawn its own windows without duplicating the dev/prod logic.
export function loadRenderer(win: BrowserWindow, htmlFile: string, query?: string): void {
  const search = query ? `?${query}` : ''
  if (isDev) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${htmlFile}${search}`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${htmlFile}`), search ? { search } : undefined)
  }
}

export function createEditorWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    // Slim hidden-inset: no visible title-bar strip, native lights tucked at top-left.
    // The top of the window is still a system drag region.
    titleBarStyle: 'hiddenInset',
    // y chosen so the native ~14px traffic-light discs centre on the same line as the
    // 26×26 sidebar buttons in the 40px-tall sidebar header (both center at y≈20).
    // Sidebar header height matches #tabs so the topbar reads as one horizontal strip.
    trafficLightPosition: { x: 14, y: 13 },
    // macOS NSVisualEffectView under the window. CSS keeps #editor solid white,
    // so vibrancy only shows through the sidebar / topbar / side panel — Finder /
    // Mail / Codex style. visualEffectState 'active' = never dim on blur.
    // No backgroundColor: vibrancy IS the window background. Setting an opaque
    // backgroundColor (or '#00000000' without transparent:true) paints over the
    // visual effect view and the glass look collapses to a flat color.
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: sharedWebPreferences
  })

  editorWindows.add(win)
  win.on('closed', () => editorWindows.delete(win))

  win.once('ready-to-show', () => win.show())

  // Surface renderer/preload problems in the main-process terminal (renderer console
  // is otherwise invisible from outside DevTools).
  win.webContents.on('console-message', (...args) => console.log('[renderer]', ...args))
  win.webContents.on('preload-error', (_e, path, error) =>
    console.error('[preload-error]', path, error)
  )
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error('[did-fail-load]', code, desc, url)
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[render-process-gone]', details)
  )

  // External http(s) links open in the default browser; deny any in-app navigation to new windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Intercept ⌘W (default macOS menu = close window) and forward to the renderer so
  // it closes the active tab instead. before-input-event preventDefault stops both
  // the page keystroke and the menu accelerator.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (mod && !input.shift && !input.alt && input.key.toLowerCase() === 'w') {
      if (!closeTabEnabled) return
      e.preventDefault()
      win.webContents.send(CH.editorCloseTab)
    }
  })

  loadRenderer(win, 'index.html')
  return win
}

// Persist the overlay's last position/size to userData so reopening drops it
// where the user left it instead of always at top-right.
const overlayBoundsPath = (): string => join(app.getPath('userData'), 'overlay.json')

function loadOverlayBounds(): Rectangle | null {
  try {
    const data = JSON.parse(readFileSync(overlayBoundsPath(), 'utf8')) as Rectangle
    return data
  } catch {
    return null
  }
}

function saveOverlayBounds(bounds: Rectangle): void {
  try {
    writeFileSync(overlayBoundsPath(), JSON.stringify(bounds), 'utf8')
  } catch (err) {
    console.error('[overlay] save bounds failed:', err)
  }
}

export function createOverlayWindow(): BrowserWindow {
  const saved = loadOverlayBounds()
  const win = new BrowserWindow({
    width: saved?.width ?? 320,
    height: saved?.height ?? 240,
    x: saved?.x,
    y: saved?.y,
    minWidth: 200,
    minHeight: 140,
    // type:'panel' installs NSWindowStyleMaskNonactivatingPanel on the underlying
    // NSWindow. With it, showInactive() lets the overlay become *key* (typeable)
    // without calling [NSApp activate] — so ⌘⇧Space surfaces the overlay+stickies
    // alone, never dragging the main editor window forward.
    type: 'panel',
    frame: false,
    // Solid (non-transparent) so macOS draws a native window shadow + rounded corners.
    transparent: false,
    backgroundColor: '#ffffff',
    skipTaskbar: true,
    resizable: true,
    fullscreenable: false,
    show: false,
    webPreferences: sharedWebPreferences
  })

  // Drop float-above on hide so a hidden window never suppresses the macOS
  // auto-hide menu bar. The all-workspaces flag is deliberately left alone:
  // changing Space membership during a hide can pull the user to another
  // Space, which reads as Memry vanishing.
  win.on('hide', () => {
    win.setAlwaysOnTop(false)
  })

  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => saveOverlayBounds(win.getBounds()), 300)
  }
  win.on('move', scheduleBoundsSave)
  win.on('resize', scheduleBoundsSave)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'overlay.html')

  overlayWindow = win
  win.on('closed', () => {
    overlayWindow = null
  })
  return win
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

// Panels cannot float over a full-screen editor Space, so the shortcut says
// so instead of opening into a broken state.
export function isEditorFullscreen(): boolean {
  for (const win of editorWindows) {
    if (!win.isDestroyed() && win.isFullScreen()) return true
  }
  return false
}

// Show the quick-capture box without touching anything else. The main window
// stays where it is and the frontmost app keeps its place. The overlay is a
// non-activating panel, so showInactive() surfaces it without pulling Memry
// forward from another app and without hiding the editor from inside Memry.
// Do NOT use show()/focus() here.
function showOverlay(overlay: BrowserWindow): void {
  if (!loadOverlayBounds()) {
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const [w] = overlay.getSize()
    const margin = 16
    overlay.setPosition(workArea.x + workArea.width - w - margin, workArea.y + margin)
  }
  // Float above other apps on the current Space. Set BEFORE showing: changing
  // Space membership after a window is visible can drag the user to another
  // Space, which reads as Memry closing.
  overlay.setAlwaysOnTop(true, 'floating')
  overlay.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // See the matching note in stickies.ts: without this flag every call
    // demotes the whole app to an accessory process, which costs Memry the
    // front. This is the actual cause of the "Memry disappears" bug.
    skipTransformProcessType: true
  })
  overlay.showInactive()
  // The renderer does not reliably get a focus event on showInactive(), so poke
  // it to put the cursor in the box straight away.
  overlay.webContents.send(CH.overlayFocusInput)
}

export function registerOverlayToggle(overlay: BrowserWindow, enabled: boolean): void {
  // ⌘⇧Space shows or hides the overlay plus every sticky note. It never
  // touches the main editor window, whichever app is frontmost.
  if (enabled) setQuickCaptureEnabled(true, overlay)
}

const QUICK_CAPTURE_ACC = 'CommandOrControl+Shift+Space'

// Switching the global capture off unregisters the hotkey entirely, so an
// overlapping shortcut in another app stops colliding.
export function setQuickCaptureEnabled(on: boolean, overlay: BrowserWindow): void {
  if (on) {
    if (globalShortcut.isRegistered(QUICK_CAPTURE_ACC)) return
    const ok = globalShortcut.register(QUICK_CAPTURE_ACC, () => handleOverlayToggle(overlay))
    if (!ok) {
      console.warn(
        '[memry] Failed to register global shortcut CommandOrControl+Shift+Space (likely owned by another app).'
      )
    }
    return
  }
  globalShortcut.unregister(QUICK_CAPTURE_ACC)
}

function handleOverlayToggle(overlay: BrowserWindow): void {
  if (isEditorFullscreen()) {
    new Notification({ title: 'Memry', body: 'Exit full screen to open sticky notes.' }).show()
    return
  }
  if (overlay.isVisible()) {
    overlay.hide()
    setStickiesVisible(false)
  } else {
    showOverlay(overlay)
    setStickiesVisible(true)
  }
}
