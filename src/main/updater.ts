// Remote updates via electron-updater (GitHub Releases). One check shortly
// after launch; a ready update downloads in the background (differential —
// only changed blocks) and installs on quit. Dev builds skip entirely.
import { app, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

export function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking...')
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] available:', info.version)
  })
  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date')
  })
  // One-click install is gated on Apple signing (Squirrel rejects ad-hoc
  // signatures), so instead of installing, offer the download. Plain
  // checkForUpdates (not AndNotify) — this dialog IS the notification.
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded')
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        message: `Memry ${info.version} is ready`,
        detail:
          'This build skips Apple signing, so updates install by hand. Download the new version and drag it to Applications.'
      })
      .then(({ response }) => {
        if (response === 0) {
          void shell.openExternal(`https://github.com/seo-joon/memry/releases/tag/v${info.version}`)
        }
      })
  })
  autoUpdater.on('error', (err) => {
    console.error('[updater] failed:', err?.message ?? err)
  })
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.error('[updater] check failed:', err)
    })
  }, 30_000)
}
