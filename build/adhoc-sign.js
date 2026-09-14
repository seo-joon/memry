// Ad-hoc sign the packaged .app.
//
// Without a "Developer ID Application" identity electron-builder skips signing
// entirely, which leaves only the linker's ad-hoc mark on the main binary:
// Identifier=Electron, Info.plist not bound, Sealed Resources=none. `codesign
// --verify` then fails with "code has no resources but signature indicates they
// must be present".
//
// That state is fatal on Apple Silicon, where every binary must carry a valid
// signature. A quarantined copy (i.e. any build a tester downloads) is reported
// as "'Memry' is damaged and can't be opened" with NO "Open Anyway" path —
// a dead end, not the unidentified-developer prompt we tell testers to expect.
//
// Signing ad-hoc (`--sign -`) produces a real bundle seal, so Gatekeeper falls
// back to the normal blocked-app flow instead. This is NOT a substitute for a
// Developer ID + notarization; it only restores the Open Anyway escape hatch.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // --deep is discouraged for Developer ID signing (it can't apply per-binary
  // entitlements) but is correct here: ad-hoc, no hardened runtime, and it
  // reaches nested helpers like chrome_crashpad_handler that a top-level sign
  // would leave stale.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })

  console.log(`  • ad-hoc signed  ${path.basename(app)}`)
}
