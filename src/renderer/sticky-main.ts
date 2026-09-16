import './style.css'
import { createEditor } from './editor/editor'
import { initTheme } from './theme'

// A sticky window learns its id from the URL (sticky.html?id=…) and pulls its text
// from main. Same CodeMirror live-preview editor as the main app, just no gutter —
// gives stickies markdown rendering, Tab-indent, and list continuation for free,
// without the bespoke list-promotion code stickies used to carry.
const id = new URLSearchParams(location.search).get('id') ?? ''
const editorEl = document.getElementById('sticky-editor') as HTMLElement
const newBtn = document.getElementById('sticky-new') as HTMLButtonElement
const closeBtn = document.getElementById('sticky-close') as HTMLButtonElement

let timer: ReturnType<typeof setTimeout> | undefined

const closeSelf = (): boolean => {
  window.api.stickies.close(id)
  return true
}

const dismissAll = (): boolean => {
  // Esc hides every panel (overlay + every sticky) without deleting any. ⌘↵ is
  // still the "I'm done with this one" delete path; Esc must never delete.
  window.api.panels.hideAll()
  return true
}

const editor = createEditor(editorEl, {
  lineNumbers: false,
  // Mod-Enter would otherwise insert a newline (defaultKeymap); keep it as the
  // explicit close-this-sticky action. Escape dismisses everything (no delete).
  extraKeymap: [
    { key: 'Mod-Enter', run: closeSelf },
    { key: 'Escape', run: dismissAll }
  ],
  onChange: (md) => {
    clearTimeout(timer)
    timer = setTimeout(() => window.api.stickies.update(id, md), 250)
  }
})

initTheme((t) => editor.setTheme(t === 'dark'))

async function load(): Promise<void> {
  editor.setContent(await window.api.stickies.get(id))
  editor.view.focus()
}
void load()

// Usual formatting keys, same as the main editor. Panel-local, so always on.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || !editor.view.hasFocus) return
  const key = e.key.toLowerCase()
  const wrap: [string, string?] | null =
    !e.shiftKey && key === 'b'
      ? ['**']
      : !e.shiftKey && key === 'i'
        ? ['*']
        : !e.shiftKey && key === 'k'
          ? ['[', '](url)']
          : e.shiftKey && key === 'c'
            ? ['`']
            : e.shiftKey && key === 's'
              ? ['~~']
              : null
  if (!wrap) return
  e.preventDefault()
  editor.wrapSelection(wrap[0], wrap[1])
})

newBtn.addEventListener('click', () => void window.api.stickies.create())
closeBtn.addEventListener('click', () => window.api.stickies.close(id))
