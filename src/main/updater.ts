// Remote updates via electron-updater (GitHub Releases). One check shortly
// after launch; a ready update downloads in the background (differential —
// only changed blocks) and installs on quit. Dev builds skip entirely.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export function checkForUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.on('update-downloaded', () => {
    console.log('[updater] update downloaded, installs on quit')
  })
  autoUpdater.on('error', (err) => {
    console.error('[updater] failed:', err?.message ?? err)
  })
  setTimeout(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      console.error('[updater] check failed:', err)
    })
  }, 30_000)
}
