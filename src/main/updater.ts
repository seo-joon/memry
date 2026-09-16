// Remote updates via electron-updater (GitHub Releases). Unsigned builds cannot
// one-click install (Squirrel rejects ad-hoc signatures), so a ready update
// pops a dialog that downloads the dmg and opens it for drag-to-Applications.
// Dev builds skip entirely.
import { app, dialog, shell, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createWriteStream } from 'node:fs'
import { get } from 'node:https'
import { join } from 'node:path'

// Fetch the dmg for in-app mounting (follows GitHub's redirects to the CDN).
// Resolves with the downloaded path in the user's Downloads folder.
function downloadDmg(version: string): Promise<string> {
  const dest = join(app.getPath('downloads'), `Memry-${version}-arm64.dmg`)
  const url = `https://github.com/seo-joon/memry/releases/download/v${version}/Memry-${version}-arm64.dmg`
  return new Promise((resolve, reject) => {
    const fetch = (u: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error('too many redirects'))
        return
      }
      get(u, (res) => {
        const loc = res.headers.location
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume()
          fetch(loc, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`download failed: ${res.statusCode}`))
          return
        }
        const out = createWriteStream(dest)
        res.pipe(out)
        out.on('finish', () => {
          out.close()
          resolve(dest)
        })
        out.on('error', reject)
      }).on('error', reject)
    }
    fetch(url, 0)
  })
}

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
  // signatures), so the dialog downloads the dmg and pops it open for
  // drag-to-Applications. Plain checkForUpdates (not AndNotify) — this
  // dialog IS the notification.
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded')
    const page = `https://github.com/seo-joon/memry/releases/tag/v${info.version}`
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        message: `Memry ${info.version} is ready`,
        detail: 'Press Download and a window will open. Drag Memry to Applications.'
      })
      .then(async ({ response }) => {
        if (response !== 0) return
        new Notification({ title: 'Downloading update…' }).show()
        try {
          const dmg = await downloadDmg(info.version)
          const err = await shell.openPath(dmg)
          if (err) throw new Error(err)
          new Notification({ title: 'Drag Memry to Applications' }).show()
        } catch (dlErr) {
          console.error('[updater] dmg download failed:', dlErr)
          await shell.openExternal(page)
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
