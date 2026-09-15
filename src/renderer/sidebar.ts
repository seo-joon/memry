// Obsidian-style file tree: nested folders + flat notes, with create / double-click
// rename / drag-drop / right-click menu. Owns the whole #sidebar (header + tree).
// All file mutations go through window.api.vault.*; the editor stays the source of
// truth for which note is open (we notify it of moves/deletes via callbacks).
import type { TreeFolder, TreeNote, VaultTree } from '../shared/ipc'

export interface Sidebar {
  refresh(): Promise<void>
  setActive(id: string | null): void
  notes(): TreeNote[]
  destroy(): void
}

export interface SidebarOptions {
  rootEl: HTMLElement
  onOpenNote: (id: string) => void
  // Flush/cancel the editor's pending autosave before a rename/move/delete touches disk.
  onBeforeMutate: () => Promise<void> | void
  onItemMoved: (oldPath: string, newPath: string) => void
  onItemDeleted: (path: string) => void
}

const EMPTY: VaultTree = { root: { name: '', path: '', folders: [], notes: [] } }
const basename = (p: string): string => p.split('/').pop() ?? p
const parentDir = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

export function mountSidebar(opts: SidebarOptions): Sidebar {
  const { rootEl, onOpenNote, onBeforeMutate, onItemMoved, onItemDeleted } = opts

  let tree: VaultTree = EMPTY
  let flat: TreeNote[] = []
  let activeId: string | null = null
  const expanded = new Set<string>(['Quick Notes'])
  let pendingRename: string | null = null
  let renaming = false
  // Multi-selection — paths the user has selected via Cmd/Shift-click. The set
  // is independent of activeId (which is the note currently being viewed). Bulk
  // actions (delete, drag-move) operate on this set when non-empty.
  const selection = new Set<string>()
  // The last "anchor" — the row a Shift-click extends FROM. Set by every plain
  // or Cmd-click. Not set by Shift-click itself (that'd make ranges runaway).
  let lastAnchor: string | null = null

  // --- chrome ---
  rootEl.replaceChildren()
  const header = el('div', 'sidebar-header')
  const collapseBtn = document.createElement('button')
  collapseBtn.type = 'button'
  collapseBtn.className = 'sidebar-toggle'
  collapseBtn.title = 'Toggle sidebar'
  collapseBtn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>'
  collapseBtn.addEventListener('click', () => rootEl.classList.toggle('collapsed'))

  // (No "click anywhere to expand" handler — when collapsed, the sidebar shrinks
  // to 0px and the topbar's #sidebar-expand-btn is the affordance to re-open.)
  const newNoteBtn = iconButton(
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    'New note',
    () => void createNoteIn('')
  )
  const newFolderBtn = iconButton(
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
    'New folder',
    () => void createFolderIn('')
  )
  header.append(newNoteBtn, newFolderBtn, collapseBtn)

  const treeEl = el('div', 'tree')
  rootEl.append(header, treeEl)

  // Click on empty tree area clears any multi-selection — matches Finder/Windows.
  treeEl.addEventListener('click', (e) => {
    if (e.target !== treeEl) return
    if (selection.size === 0) return
    selection.clear()
    lastAnchor = null
    render()
  })

  // Empty space + root accepts drops (move to vault root) and right-click (create at root).
  makeDropTarget(treeEl, '')
  treeEl.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    showMenu(e.clientX, e.clientY, [
      ['New note', () => void createNoteIn('')],
      ['New folder', () => void createFolderIn('')]
    ])
  })

  // --- data ---
  function flatten(folder: TreeFolder, acc: TreeNote[]): void {
    acc.push(...folder.notes)
    folder.folders.forEach((f) => flatten(f, acc))
  }

  async function refresh(): Promise<void> {
    tree = await window.api.vault.tree()
    flat = []
    flatten(tree.root, flat)
    render()
  }

  // --- render ---
  function render(): void {
    if (renaming) return // a rename's inline <input> is live in the tree — preserve it
    treeEl.replaceChildren()
    for (const f of tree.root.folders) treeEl.append(renderFolder(f, 0))
    for (const n of tree.root.notes) treeEl.append(renderNote(n, 0))
    if (pendingRename) {
      const name = treeEl.querySelector(`[data-rename="${cssEscape(pendingRename)}"]`)
      pendingRename = null
      if (name instanceof HTMLElement) startRename(name)
    }
  }

  function renderFolder(folder: TreeFolder, depth: number): HTMLElement {
    const wrap = document.createElement('div')
    const row = makeRow(depth, folder.path, 'folder')
    row.classList.add('tree-folder')
    if (selection.has(folder.path)) row.classList.add('selected')
    const chev = el('span', 'tree-chevron')
    chev.textContent = expanded.has(folder.path) ? '▾' : '▸'
    const name = makeName(folder.name, folder.path, false)
    row.append(chev, name)
    row.addEventListener('click', (e) => handleRowClick(e, folder.path, 'folder'))
    wrap.append(row)
    if (expanded.has(folder.path)) {
      const children = el('div', 'tree-children')
      children.style.setProperty('--guide-x', `${16 + depth * 18}px`)
      for (const f of folder.folders) children.append(renderFolder(f, depth + 1))
      for (const n of folder.notes) children.append(renderNote(n, depth + 1))
      wrap.append(children)
    }
    return wrap
  }

  function renderNote(note: TreeNote, depth: number): HTMLElement {
    const row = makeRow(depth, note.id, 'note')
    row.classList.add('tree-note')
    if (note.id === activeId) row.classList.add('active')
    if (selection.has(note.id)) row.classList.add('selected')
    const name = makeName(note.title, note.id, true)
    row.append(name)
    row.addEventListener('click', (e) => handleRowClick(e, note.id, 'note'))
    return row
  }

  // The flat, in-visual-order list of every row currently rendered — folders
  // and notes, depth-first, skipping collapsed-folder children. Shift-click uses
  // this to compute "everything between anchor and target".
  function visibleOrder(): Array<{ path: string; kind: 'note' | 'folder' }> {
    const acc: Array<{ path: string; kind: 'note' | 'folder' }> = []
    const walk = (f: TreeFolder): void => {
      if (f.path !== '') acc.push({ path: f.path, kind: 'folder' })
      if (f.path === '' || expanded.has(f.path)) {
        for (const child of f.folders) walk(child)
        for (const n of f.notes) acc.push({ path: n.id, kind: 'note' })
      }
    }
    walk(tree.root)
    return acc
  }

  // Standard file-manager click semantics:
  //   plain click  → clear selection, perform default action (open note / toggle folder)
  //   Cmd/Ctrl     → toggle this row in the selection, no default action
  //   Shift        → select inclusive range between lastAnchor and this row
  function handleRowClick(e: MouseEvent, path: string, kind: 'note' | 'folder'): void {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      if (selection.has(path)) selection.delete(path)
      else selection.add(path)
      lastAnchor = path
      render()
      return
    }
    if (e.shiftKey && lastAnchor) {
      e.preventDefault()
      e.stopPropagation()
      const order = visibleOrder()
      const fromIdx = order.findIndex((o) => o.path === lastAnchor)
      const toIdx = order.findIndex((o) => o.path === path)
      if (fromIdx !== -1 && toIdx !== -1) {
        const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
        selection.clear()
        for (let i = lo; i <= hi; i++) selection.add(order[i].path)
      }
      render()
      return
    }
    // No modifier — clear selection and do the default action for this row.
    selection.clear()
    lastAnchor = path
    if (kind === 'note') {
      render() // snap visual to cleared selection before the async open kicks in
      onOpenNote(path)
    } else {
      toggle(path) // toggle() already re-renders
    }
  }

  // Lookup whether a path is a note or folder (used when we only have the path,
  // e.g. building a multi-drag payload from `selection`).
  function kindOf(path: string): 'note' | 'folder' {
    return flat.some((n) => n.id === path) ? 'note' : 'folder'
  }

  // A row: indent + drag source + drop target (folders) + context menu.
  function makeRow(depth: number, path: string, kind: 'note' | 'folder'): HTMLElement {
    const row = el('div', 'tree-row')
    row.style.paddingLeft = `${8 + depth * 18}px`
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation()
      // If this row is part of a multi-selection, drag every selected item.
      // Otherwise drag just this row (and clear any stale selection visually
      // wouldn't matter — selection is preserved across drags by design).
      const items =
        selection.has(path) && selection.size > 1
          ? [...selection].map((p) => ({ path: p, kind: kindOf(p) }))
          : [{ path, kind }]
      e.dataTransfer?.setData('text/plain', JSON.stringify(items))
    })
    if (kind === 'folder') makeDropTarget(row, path)
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const name = row.querySelector('.tree-name')
      const items: [string, () => void][] = []
      // Multi-select aware: if this row is part of a non-trivial selection, the
      // context menu's Delete acts on every selected item. Rename / create-new
      // only make sense on a single row, so they're hidden in that case.
      const multi = selection.has(path) && selection.size > 1
      if (!multi) {
        if (kind === 'folder') {
          items.push(['New note', () => void createNoteIn(path)])
          items.push(['New folder', () => void createFolderIn(path)])
        }
        if (name instanceof HTMLElement) items.push(['Rename', () => startRename(name)])
      }
      const delLabel = multi ? `Delete ${selection.size} items` : 'Delete'
      const delAction = multi ? () => void delMany([...selection]) : () => void del(path, kind)
      items.push([delLabel, delAction])
      showMenu(e.clientX, e.clientY, items)
    })
    return row
  }

  function makeName(label: string, path: string, isNote: boolean): HTMLElement {
    const name = el('span', 'tree-name')
    name.textContent = label
    // Full name on hover for truncated labels (long quick-note timestamps).
    name.title = label
    name.dataset.path = path
    name.dataset.note = String(isNote)
    name.dataset.rename = path
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      startRename(name)
    })
    return name
  }

  function toggle(path: string): void {
    if (expanded.has(path)) expanded.delete(path)
    else expanded.add(path)
    render()
  }

  // --- rename (inline input) ---
  function startRename(name: HTMLElement): void {
    const path = name.dataset.path!
    const isNote = name.dataset.note === 'true'
    const input = el('input', 'tree-rename') as HTMLInputElement
    input.value = isNote ? basename(path).replace(/\.md$/i, '') : basename(path)
    name.replaceWith(input)
    renaming = true
    input.focus()
    input.select()
    input.addEventListener('click', (e) => e.stopPropagation())
    let done = false
    const finish = (): void => {
      renaming = false
    }
    const commit = async (): Promise<void> => {
      if (done) return
      done = true
      const raw = input.value.trim()
      const parent = parentDir(path)
      const newName = isNote ? `${raw.replace(/\.md$/i, '')}.md` : raw
      const dest = parent ? `${parent}/${newName}` : newName
      if (!raw || dest === path) {
        finish()
        return void refresh()
      }
      await onBeforeMutate()
      const finalPath = await window.api.vault.move(path, dest)
      finish()
      await refresh()
      onItemMoved(path, finalPath)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void commit()
      } else if (e.key === 'Escape') {
        done = true
        finish()
        void refresh()
      }
    })
    input.addEventListener('blur', () => void commit())
  }

  // --- create / delete ---
  async function createNoteIn(folder: string): Promise<void> {
    const meta = await window.api.notes.create({ folder })
    if (folder) expanded.add(folder)
    pendingRename = meta.id
    await refresh()
    onOpenNote(meta.id)
  }

  async function createFolderIn(parent: string): Promise<void> {
    const path = await window.api.vault.folderCreate(parent, 'New Folder')
    if (parent) expanded.add(parent)
    expanded.add(path)
    pendingRename = path
    await refresh()
  }

  async function del(path: string, kind: 'note' | 'folder'): Promise<void> {
    const suffix = kind === 'folder' ? ' and its contents' : ''
    if (!window.confirm(`Delete "${basename(path)}"${suffix}?`)) return
    await onBeforeMutate()
    await window.api.vault.delete(path)
    await refresh()
    onItemDeleted(path)
  }

  // Bulk delete for the multi-selection. One confirm, then deletes everything
  // sequentially. Folders/notes are treated the same — main's vault.delete is
  // recursive. Selection is cleared at the end whether or not anything was deleted.
  async function delMany(paths: string[]): Promise<void> {
    if (!paths.length) return
    if (!window.confirm(`Delete ${paths.length} item${paths.length === 1 ? '' : 's'}?`)) return
    await onBeforeMutate()
    for (const p of paths) {
      try {
        await window.api.vault.delete(p)
      } catch (err) {
        console.error('[sidebar] bulk delete failed for', p, err)
      }
    }
    selection.clear()
    lastAnchor = null
    await refresh()
    for (const p of paths) onItemDeleted(p)
  }

  // --- drag-drop target ---
  function makeDropTarget(target: HTMLElement, destFolder: string): void {
    target.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
      target.classList.add('drop-into')
    })
    target.addEventListener('dragleave', () => target.classList.remove('drop-into'))
    target.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      target.classList.remove('drop-into')
      const raw = e.dataTransfer?.getData('text/plain')
      if (raw) void handleDrop(destFolder, raw)
    })
  }

  async function handleDrop(destFolder: string, raw: string): Promise<void> {
    // Payload is always an array (a single-row drag is [{path, kind}], multi-row
    // is the full selection). Tolerates the older single-object shape just in case.
    let items: Array<{ path: string; kind: 'note' | 'folder' }>
    try {
      const parsed = JSON.parse(raw)
      items = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }
    if (!items.length) return
    await onBeforeMutate()
    for (const data of items) {
      const src = data.path
      const dest = destFolder ? `${destFolder}/${basename(src)}` : basename(src)
      if (src === dest || parentDir(src) === destFolder) continue
      // A folder can't be moved into itself or one of its own descendants.
      if (data.kind === 'folder' && (destFolder === src || destFolder.startsWith(`${src}/`))) {
        continue
      }
      try {
        const finalPath = await window.api.vault.move(src, dest)
        onItemMoved(src, finalPath)
      } catch (err) {
        console.error('[sidebar] move failed for', src, '→', dest, err)
      }
    }
    selection.clear()
    lastAnchor = null
    await refresh()
  }

  return {
    refresh,
    setActive(id) {
      activeId = id
      render()
    },
    notes: () => flat,
    destroy() {
      closeMenu()
      rootEl.replaceChildren()
    }
  }
}

// --- tiny DOM helpers ---
function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

function iconButton(svg: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'sidebar-icon-btn'
  b.title = title
  b.innerHTML = svg
  b.addEventListener('click', onClick)
  return b
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

// --- shared context menu ---
let menuEl: HTMLElement | null = null

function closeMenu(): void {
  menuEl?.remove()
  menuEl = null
  document.removeEventListener('click', closeMenu)
  document.removeEventListener('contextmenu', onOutsideContext, true)
}

function onOutsideContext(e: Event): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu()
}

function showMenu(x: number, y: number, items: [string, () => void][]): void {
  closeMenu()
  const menu = el('div', 'context-menu')
  for (const [label, fn] of items) {
    const item = el('div', 'context-menu-item')
    item.textContent = label
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      closeMenu()
      fn()
    })
    menu.append(item)
  }
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  document.body.append(menu)
  menuEl = menu
  // Close on the next click anywhere / right-click outside.
  setTimeout(() => {
    document.addEventListener('click', closeMenu)
    document.addEventListener('contextmenu', onOutsideContext, true)
  })
}
