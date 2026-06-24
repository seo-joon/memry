import { BrowserWindow, app, shell, globalShortcut, screen, type Rectangle } from 'electron'
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
    show: false,
    webPreferences: sharedWebPreferences
  })

  // Apply float-above + cross-Spaces ONLY while the overlay is visible. Applying these
  // at creation (even while hidden) can app-wide suppress the macOS auto-hide menu bar
  // from revealing on cursor-to-top — so we defer them to the show event and clear on hide.
  win.on('show', () => {
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  })
  win.on('hide', () => {
    win.setAlwaysOnTop(false)
    win.setVisibleOnAllWorkspaces(false)
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

// Make the overlay the key window so ⌘↵ / esc are delivered to its textarea — not
// the app the user was in when they hit the shortcut. On first ever launch (no saved
// bounds), drop it near the top-right of the cursor's display; thereafter the saved
// position is already on the window from createOverlayWindow().
function showOverlay(overlay: BrowserWindow): void {
  if (!loadOverlayBounds()) {
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const [w] = overlay.getSize()
    const margin = 16
    overlay.setPosition(workArea.x + workArea.width - w - margin, workArea.y + margin)
  }
  // The overlay is a type:'panel' BrowserWindow. showInactive() on a panel grants
  // key status (so the textarea receives keystrokes immediately) WITHOUT activating
  // the app — that's the only way to surface the overlay without macOS pulling the
  // main editor window forward. Do NOT call show()/focus() here.
  overlay.showInactive()
  // The renderer's `window.focus` event doesn't reliably fire on a panel-window
  // showInactive(), so the textarea wouldn't auto-focus on second+ summon. Poke
  // the renderer explicitly so the user can type immediately.
  overlay.webContents.send(CH.overlayFocusInput)
}

export function registerOverlayToggle(overlay: BrowserWindow): void {
  // ⌘⇧Space is the only path that toggles stickies alongside the overlay. The
  // overlay's own ×/Esc/Keep-as-sticky buttons close just the overlay — otherwise
  // "Keep as sticky" would create a sticky and then hide it (and every sibling sticky)
  // when the overlay closes.
  const ok = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (overlay.isVisible()) {
      overlay.hide()
      setStickiesVisible(false)
    } else {
      showOverlay(overlay)
      setStickiesVisible(true)
    }
  })
  if (!ok) {
    console.warn(
      '[memry] Failed to register global shortcut CommandOrControl+Shift+Space (likely owned by another app).'
    )
  }
}
