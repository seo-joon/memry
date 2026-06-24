import { protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { resolveAsset } from './vault'

// memry://vault/<rel> serves vault images/assets under contextIsolation without exposing file://.
// Must be registered BEFORE app is ready.
export function registerMemrySchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'memry',
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

// Must be called AFTER app is ready.
export function handleMemryProtocol(): void {
  protocol.handle('memry', (req) => {
    // memry://vault/foo/bar.png -> host 'vault', pathname '/foo/bar.png'
    const { pathname } = new URL(req.url)
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    return net.fetch(pathToFileURL(resolveAsset(rel)).toString())
  })
}
