import { app, systemPreferences, shell } from 'electron'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { MediaAccessStatus } from '../shared/ipc'

// Prompts for microphone access if not yet determined; resolves to whether access is granted.
export function ensureMicAccess(): Promise<boolean> {
  return systemPreferences.askForMediaAccess('microphone')
}

// Read-only Screen Recording status. macOS has no askForMediaAccess('screen'); only this getter.
export function screenAccessStatus(): MediaAccessStatus {
  return systemPreferences.getMediaAccessStatus('screen') as MediaAccessStatus
}

// Self-heal for the stale-entry problem: every ad-hoc rebuild changes the code
// signature, so macOS keeps showing the toggle as on while denying capture.
// This clears ONLY this app's own Screen Recording entry (never a bare reset,
// which would wipe every other app's consent), then relaunches so the next
// capture attempt gets a fresh Allow prompt. No Settings visit, no restart.
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())))
  })
}

export async function repairScreenRecording(): Promise<boolean> {
  try {
    // Bundle id of the actually-running app (Memry when packaged, Electron in
    // dev) — read from its own Info.plist, never hardcoded.
    const plist = join(dirname(app.getPath('exe')), '..', 'Info.plist')
    const target = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])
    if (!target) return false
    await run('/usr/bin/tccutil', ['reset', 'ScreenCapture', target])
  } catch {
    return false
  }
  app.relaunch()
  app.exit(0)
  return true
}

// Deep-link straight to System Settings > Privacy & Security > Screen Recording.
export function openScreenRecordingSettings(): void {
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  )
}
