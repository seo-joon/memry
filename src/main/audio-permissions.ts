import { systemPreferences, shell } from 'electron'
import type { MediaAccessStatus } from '../shared/ipc'

// Prompts for microphone access if not yet determined; resolves to whether access is granted.
export function ensureMicAccess(): Promise<boolean> {
  return systemPreferences.askForMediaAccess('microphone')
}

// Read-only Screen Recording status. macOS has no askForMediaAccess('screen'); only this getter.
export function screenAccessStatus(): MediaAccessStatus {
  return systemPreferences.getMediaAccessStatus('screen') as MediaAccessStatus
}

// Deep-link straight to System Settings > Privacy & Security > Screen Recording.
export function openScreenRecordingSettings(): void {
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  )
}
