// Settings modal: per-Mac API keys. Values live in the main process
// (Keychain-encrypted file) and are fetched only to prefill the fields.
// Styled with the shared help-modal classes plus the settings rows below.
import { KEYBINDS } from '../shared/keybinds'

export interface SettingsHandle {
  open(): void
  toggle(): void
  close(): void
}

export function mountSettings(): SettingsHandle {
  const modal = document.createElement('div')
  modal.className = 'help-modal'
  modal.hidden = true
  modal.innerHTML = `
    <div class="help-backdrop" data-close></div>
    <div class="help-panel" role="dialog" aria-modal="true" aria-label="Memry settings">
      <header class="help-header">
        <h1 class="help-title">Settings</h1>
        <button class="help-close" data-close type="button" aria-label="Close">×</button>
      </header>
      <div class="help-content">
        <label class="settings-row">
          <span class="settings-label">OpenAI API key</span>
          <input class="settings-input" data-openai type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" />
          <span class="settings-caption">Summaries, tidy-ups and writing suggestions</span>
        </label>
        <label class="settings-row">
          <span class="settings-label">Groq API key</span>
          <input class="settings-input" data-groq type="password" autocomplete="off" spellcheck="false" placeholder="gsk-…" />
          <span class="settings-caption">Meeting and lecture transcription</span>
        </label>
        <div class="settings-actions">
          <button class="settings-save" data-save type="button">Save</button>
          <span class="settings-status" data-status></span>
        </div>
        <p class="settings-note">Keys stay on this Mac. They apply straight away.</p>
        <h2 class="settings-subhead">Shortcuts</h2>
        <p class="settings-note">Switch off anything that clashes with your other apps.</p>
        <div class="settings-shortcuts" data-shortcuts></div>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const openaiEl = modal.querySelector<HTMLInputElement>('[data-openai]') as HTMLInputElement
  const groqEl = modal.querySelector<HTMLInputElement>('[data-groq]') as HTMLInputElement
  const saveEl = modal.querySelector<HTMLButtonElement>('[data-save]') as HTMLButtonElement
  const statusEl = modal.querySelector<HTMLElement>('[data-status]') as HTMLElement
  const shortcutsEl = modal.querySelector<HTMLElement>('[data-shortcuts]') as HTMLElement

  // One checkbox row per shortcut, built from the shared list so labels and
  // key names never drift from the help page.
  const boxes = new Map<string, HTMLInputElement>()
  for (const k of KEYBINDS) {
    const row = document.createElement('label')
    row.className = 'settings-shortcut'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = k.def
    box.addEventListener('change', () => {
      void window.api.keybinds.set(k.id, box.checked).then(
        (map) => {
          window.dispatchEvent(new CustomEvent('memry:keybinds', { detail: map }))
          statusEl.textContent = box.checked ? `${k.label} on.` : `${k.label} off.`
        },
        () => {
          box.checked = !box.checked
          statusEl.textContent = 'Could not save that change.'
        }
      )
    })
    const name = document.createElement('span')
    name.textContent = k.label
    const keys = document.createElement('kbd')
    keys.textContent = k.keys
    row.append(box, name, keys)
    shortcutsEl.appendChild(row)
    boxes.set(k.id, box)
  }

  const close = (): void => {
    modal.hidden = true
  }
  const open = (): void => {
    statusEl.textContent = ''
    modal.hidden = false
    void window.api.settings.get().then(
      (keys) => {
        openaiEl.value = keys.openaiApiKey
        groqEl.value = keys.groqApiKey
      },
      () => {
        statusEl.textContent = 'Could not load saved keys.'
      }
    )
    void window.api.keybinds.get().then(
      (map) => {
        for (const [id, box] of boxes) box.checked = map[id] ?? box.checked
      },
      () => undefined
    )
    openaiEl.focus()
  }
  const toggle = (): void => {
    if (modal.hidden) open()
    else close()
  }

  saveEl.addEventListener('click', () => {
    statusEl.textContent = 'Saving…'
    void window.api.settings
      .set({ openaiApiKey: openaiEl.value, groqApiKey: groqEl.value })
      .then(
        () => {
          statusEl.textContent = 'Saved.'
        },
        () => {
          statusEl.textContent = 'Could not save keys.'
        }
      )
  })

  // Enter in either field saves.
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target === openaiEl || e.target === groqEl)) {
      e.preventDefault()
      saveEl.click()
    }
    if (e.key === 'Escape' && !modal.hidden) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('[data-close]')) close()
  })

  return { open, toggle, close }
}
