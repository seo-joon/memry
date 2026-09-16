// Theme boot + live sync, shared by every renderer window (editor, overlay,
// stickies). The stored theme lives in main; this sets `data-theme` on the
// document so style.css flips, and forwards to the CodeMirror surface when the
// caller has one.
import type { Theme } from '../shared/ipc'

export function initTheme(onChange?: (t: Theme) => void): void {
  const apply = (t: Theme): void => {
    document.documentElement.dataset.theme = t
    onChange?.(t)
  }
  void window.api.theme.get().then(apply, () => undefined)
  window.api.theme.onChange(apply)
}
