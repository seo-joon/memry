// The canonical shortcut list. Renderer builds the Settings toggles from it,
// main reads the stored prefs for the shortcuts it owns (global capture, ⌘W).
export interface KeybindDef {
  id: string
  label: string
  keys: string
  def: boolean
}

export const KEYBINDS: KeybindDef[] = [
  { id: 'quickCapture', label: 'Sticky notes', keys: '⌘⇧Space', def: true },
  { id: 'newNote', label: 'New note in a new tab', keys: '⌘N', def: true },
  { id: 'newTab', label: 'New empty tab', keys: '⌘T', def: true },
  { id: 'reopenTab', label: 'Bring back a closed tab', keys: '⌘⇧T', def: true },
  { id: 'closeTab', label: 'Close this tab', keys: '⌘W', def: true },
  { id: 'sidePanel', label: 'Show or hide the side panel', keys: '⌘E', def: true },
  { id: 'quickOpen', label: 'Find a note and open it', keys: '⌘O', def: true },
  { id: 'help', label: 'Open help', keys: '⌘/', def: true },
  { id: 'ghostAccept', label: 'Accept the grey suggestion', keys: 'Tab', def: true },
  { id: 'ghostDismiss', label: 'Dismiss the grey suggestion', keys: 'Esc', def: true },
  { id: 'formatBold', label: 'Bold', keys: '⌘B', def: true },
  { id: 'formatItalic', label: 'Italic', keys: '⌘I', def: true },
  { id: 'formatLink', label: 'Link', keys: '⌘K', def: true },
  { id: 'formatCode', label: 'Inline code', keys: '⌘⇧C', def: true },
  { id: 'formatStrike', label: 'Strikethrough', keys: '⌘⇧S', def: true }
]

export function defaultKeybinds(): Record<string, boolean> {
  return Object.fromEntries(KEYBINDS.map((k) => [k.id, k.def]))
}
