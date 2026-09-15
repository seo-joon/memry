// Order is load-bearing: the loopback shim must append Chromium switches before anything else.
import './loopback-setup'

import { resolve } from 'node:path'
import dotenv from 'dotenv'
import { app, BrowserWindow, Menu, globalShortcut, nativeTheme } from 'electron'
import { registerMemrySchemePrivileged, handleMemryProtocol } from './protocol'
import {
  createEditorWindow,
  createOverlayWindow,
  registerOverlayToggle,
  setCloseTabEnabled
} from './windows'
import { registerIpc } from './ipc'
import { restoreStickies, flushStickies } from './stickies'
import { loadUserKeys } from './keys'
import { getKeybinds } from './prefs'
import { checkForUpdates } from './updater'

// Load env vars BEFORE any service that consumes them. In dev we want the
// project-root .env (default behaviour — cwd-relative). In a packaged build,
// process.cwd() is wherever the user launched from, so we instead read the .env
// that electron-builder copied into Contents/Resources/ via extraResources.
dotenv.config({
  path: app.isPackaged ? resolve(process.resourcesPath, '.env') : undefined
})

// Dev runs the bare Electron binary which advertises itself as "Electron" in the menu
// bar; production reads productName from package.json. Force the user-facing name early.
app.setName('Memry')

// Force light appearance app-wide. Without this, `vibrancy: 'sidebar'` on the editor
// window adapts to the user's macOS theme — in dark mode it renders a near-black
// frosted material, which clashes with the white editor pane. Locked to light so the
// sidebar / topbar / side panel always show the light frosted-white variant.
nativeTheme.themeSource = 'light'

// Privileged scheme registration must happen before app is ready.
registerMemrySchemePrivileged()

// Standard macOS application menu — without this, Electron uses a stub default that
// macOS treats as effectively empty, so auto-hide menu bars fail to reveal on
// cursor-to-top. Standard roles give native shortcuts (⌘Q, ⌘W, copy/paste, etc.) for free.
function buildAppMenu(): Electron.Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
    }
  ]
  return Menu.buildFromTemplate(template)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildAppMenu())
  // Per-Mac keys from Settings (Keychain-encrypted). Anything already in the
  // environment (dev .env) wins.
  await loadUserKeys()
  handleMemryProtocol()
  createEditorWindow()
  const overlay = createOverlayWindow()
  registerIpc()
  const keybinds = await getKeybinds()
  setCloseTabEnabled(keybinds.closeTab)
  registerOverlayToggle(overlay, keybinds.quickCapture)
  checkForUpdates()
  void restoreStickies()

  // macOS: recreate the editor window when the dock icon is clicked and no windows are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditorWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  flushStickies() // synchronously persist any pending sticky text/bounds before exit
})
