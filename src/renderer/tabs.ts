// Obsidian-style tab bar. Each tab is either an open note ("note" kind, with a
// nullable noteId for empty "New tab" slots) or a detached graph view ("graph"
// kind, scoped to one analysis entry). Tab state lives in editor-main; this
// module owns the bar UI + the "+" menu + the small "open existing" search popup.
import type { TreeNote } from '../shared/ipc'

export type Tab =
  | { kind: 'note'; noteId: string | null }
  | { kind: 'graph'; noteId: string; entryId: string }

export interface TabBarOptions {
  rootEl: HTMLElement
  getTitle: (tab: Tab) => string
  onNewNote: () => void
  onSwitch: (idx: number) => void
  onClose: (idx: number) => void
  onReorder: (from: number, to: number) => void
}

export interface TabBar {
  render(tabs: Tab[], activeIdx: number): void
  destroy(): void
}

export function mountTabBar(opts: TabBarOptions): TabBar {
  const { rootEl } = opts

  function render(tabs: Tab[], activeIdx: number): void {
    rootEl.replaceChildren()
    tabs.forEach((tab, idx) => {
      const t = document.createElement('div')
      const kindClass = tab.kind === 'graph' ? ' tab-graph' : ''
      t.className = 'tab' + (idx === activeIdx ? ' active' : '') + kindClass
      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = opts.getTitle(tab)
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.type = 'button'
      close.innerHTML = '×'
      close.title = 'Close tab'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        opts.onClose(idx)
      })
      t.append(title, close)
      t.addEventListener('click', () => opts.onSwitch(idx))
      // Drag-and-drop reorder.
      t.draggable = true
      t.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/x-tab-idx', String(idx))
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        t.classList.add('dragging')
      })
      t.addEventListener('dragend', () => t.classList.remove('dragging'))
      t.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('text/x-tab-idx')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = t.getBoundingClientRect()
        const before = e.clientX < r.left + r.width / 2
        t.classList.toggle('drop-before', before)
        t.classList.toggle('drop-after', !before)
      })
      t.addEventListener('dragleave', () => {
        t.classList.remove('drop-before', 'drop-after')
      })
      t.addEventListener('drop', (e) => {
        const raw = e.dataTransfer?.getData('text/x-tab-idx')
        t.classList.remove('drop-before', 'drop-after')
        if (raw == null || raw === '') return
        e.preventDefault()
        const from = parseInt(raw, 10)
        if (isNaN(from) || from === idx) return
        const r = t.getBoundingClientRect()
        const before = e.clientX < r.left + r.width / 2
        let to = before ? idx : idx + 1
        if (from < to) to-- // account for removal-before-insert
        if (to !== from) opts.onReorder(from, to)
      })
      rootEl.append(t)
    })
    const plus = document.createElement('button')
    plus.className = 'tab-plus'
    plus.type = 'button'
    plus.textContent = '+'
    plus.title = 'New tab'
    plus.addEventListener('click', (e) => {
      e.stopPropagation()
      // Direct new-note creation — matches ⌘N. The old dropdown ("New note / Open
      // existing…") felt like an interruption; ⌘T still opens the empty-tab
      // placeholder if the user wants the picker UI.
      opts.onNewNote()
    })
    rootEl.append(plus)
  }

  return {
    render,
    destroy() {
      rootEl.replaceChildren()
    }
  }
}

export function showNoteSearch(notes: TreeNote[], onPick: (id: string) => void): void {
  document.querySelectorAll('.search-popup').forEach((p) => p.remove())
  const popup = document.createElement('div')
  popup.className = 'search-popup'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Find note…'
  input.className = 'search-input'
  const list = document.createElement('div')
  list.className = 'search-list'
  popup.append(input, list)
  document.body.append(popup)

  function update(): void {
    const q = input.value.toLowerCase().trim()
    const filtered = q
      ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
      : notes
    list.replaceChildren()
    filtered.slice(0, 20).forEach((n) => {
      const item = document.createElement('div')
      item.className = 'search-item'
      item.textContent = n.title
      item.addEventListener('click', () => {
        popup.remove()
        onPick(n.id)
      })
      list.append(item)
    })
  }

  update()
  input.addEventListener('input', update)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') popup.remove()
    if (e.key === 'Enter') {
      const first = list.querySelector('.search-item') as HTMLElement | null
      first?.click()
    }
  })
  setTimeout(() => {
    document.addEventListener(
      'click',
      function once(e) {
        if (!popup.contains(e.target as Node)) {
          popup.remove()
          document.removeEventListener('click', once)
        }
      },
      true
    )
  })
  input.focus()
}
