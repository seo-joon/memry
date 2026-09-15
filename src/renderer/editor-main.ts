import './style.css'
import { createEditor } from './editor/editor'
import { mountSidebar } from './sidebar'
import { mountTabBar, showNoteSearch, type Tab } from './tabs'
import { mountTranscriptionUI } from './transcription-ui'
import { mountSidePanel, GRAPH_DRAG_MIME } from './sidepanel'
import { mountGraph, type GraphHandle } from './graph'
import { mountHelp, shouldShowHelpOnLaunch } from './help'
import { mountSettings } from './settings'
import { KEYBINDS } from '../shared/keybinds'

const sidebarEl = document.getElementById('sidebar') as HTMLElement
const tabsEl = document.getElementById('tabs') as HTMLElement
const editorEl = document.getElementById('editor') as HTMLElement
const transcriptionEl = document.getElementById('transcription') as HTMLElement
const transcriptEl = document.getElementById('transcript') as HTMLElement
const recordBtn = document.getElementById('record-btn') as HTMLButtonElement
const recordPopoverEl = document.getElementById('record-popover') as HTMLElement
const helpBtn = document.getElementById('help-btn') as HTMLButtonElement
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
const sidebarExpandBtn = document.getElementById('sidebar-expand-btn') as HTMLButtonElement
sidebarExpandBtn.addEventListener('click', () => {
  sidebarEl.classList.remove('collapsed')
})
const placeholderEl = document.getElementById('new-tab-placeholder') as HTMLElement
const graphTabViewEl = document.getElementById('graph-tab-view') as HTMLElement
const graphTabContainerEl = document.getElementById('graph-tab-container') as HTMLElement
const graphTabTitleEl = graphTabViewEl.querySelector('[data-graph-tab-title]') as HTMLElement
const graphTabDetailEl = graphTabViewEl.querySelector('[data-graph-tab-detail]') as HTMLElement
const graphTabDetailTitleEl = graphTabViewEl.querySelector('[data-graph-tab-detail-title]') as HTMLElement
const graphTabDetailDescEl = graphTabViewEl.querySelector('[data-graph-tab-detail-desc]') as HTMLElement
const graphTabDetailSourcesEl = graphTabViewEl.querySelector('[data-graph-tab-detail-sources]') as HTMLElement
const graphTabDetailCloseEl = graphTabViewEl.querySelector('[data-graph-tab-detail-close]') as HTMLButtonElement

// Each tab is either an open note slot or a detached graph view.
let tabs: Tab[] = [{ kind: 'note', noteId: null }]
let activeTabIdx = 0

// The noteId the editor is bound to right now. Graph tabs return null — they
// don't take edits, so save/recording/ghost-text correctly skip them.
const activeId = (): string | null => {
  const t = tabs[activeTabIdx]
  return t?.kind === 'note' ? t.noteId : null
}

// The noteId the side panel should track. Both note and graph tabs belong to
// some note, so the panel always has a meaningful context whichever kind is up.
const panelContextNoteId = (): string | null => {
  const t = tabs[activeTabIdx]
  if (!t) return null
  return t.kind === 'note' ? t.noteId : t.noteId
}

// LIFO stack for ⌘⇧T (reopen). Only real note tabs are worth restoring.
const closedStack: string[] = []
const CLOSED_STACK_MAX = 100

let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingContent = ''

// The noteId the side panel's current entries belong to. Used by graph-popout /
// graph-drag so they spawn a graph tab pointing at the RIGHT note — `panelContextNoteId`
// returns the *active tab*'s noteId, which can race ahead of the panel's data during a
// tab switch (active tab is the new note, panel still shows the old note's entries).
let panelEntriesNoteId: string | null = null

function applyPanelEntries(
  noteId: string | null,
  entries: Awaited<ReturnType<typeof window.api.analysis.list>>,
  preferEntryId?: string | null
): void {
  panelEntriesNoteId = noteId
  panel.setEntries(entries, preferEntryId)
}

function scheduleSave(md: string): void {
  pendingContent = md
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const id = activeId()
    if (id) void window.api.notes.update(id, pendingContent)
  }, 400)
}

// Shortcut toggles from Settings. Defaults apply until the stored map loads;
// the settings panel broadcasts changes on the window for a live update.
const kb: Record<string, boolean> = Object.fromEntries(KEYBINDS.map((k) => [k.id, k.def]))
void window.api.keybinds.get().then(
  (stored) => Object.assign(kb, stored),
  () => undefined
)
window.addEventListener('memry:keybinds', (e) => {
  Object.assign(kb, (e as CustomEvent<Record<string, boolean>>).detail)
})

const editor = createEditor(editorEl, {
  onChange: (doc) => {
    if (activeId()) scheduleSave(doc)
    scheduleWritingAbout()
  },
  onCaretMove: () => scheduleWritingAbout(),
  onOpenNote: (target) => void openWikiTarget(target),
  ghostText: {
    request: async (paragraph) => {
      const id = activeId()
      if (!id) return ''
      return window.api.suggest.complete(id, paragraph)
    },
    acceptEnabled: () => kb.ghostAccept,
    dismissEnabled: () => kb.ghostDismiss
  },
  imagePaste: {
    writeAsset: (filename, base64) => window.api.vault.writeAsset(filename, base64)
  }
})

const panel = mountSidePanel({
  // Re-analyze re-runs the active entry on its preserved source text. The entry
  // id is kept so the dropdown selection survives the refresh.
  onReanalyze: async (entry) => {
    const noteId = panelContextNoteId()
    if (!noteId || !entry.sourceText) return
    panel.setLoading(true)
    try {
      await window.api.analysis.replace(noteId, entry.id, entry.sourceText)
    } finally {
      panel.setLoading(false)
    }
    const entries = await window.api.analysis.list(noteId)
    if (panelContextNoteId() === noteId) applyPanelEntries(noteId, entries, entry.id)
  },
  onGraphPopout: (entry) => {
    // Use the panel's OWN noteId (the note whose entries are currently displayed)
    // rather than the active tab's — protects against a tab-switch race where the
    // popout would otherwise try to find this entry in a different note's data.
    const noteId = panelEntriesNoteId
    console.log('[popout] onGraphPopout. panelEntriesNoteId=%s entry=%s', noteId, entry.id)
    if (!noteId) return
    void openGraphInNewTab(noteId, entry.id)
  },
  onGraphDragPayload: (entry) => {
    const noteId = panelEntriesNoteId
    if (!noteId) return null
    return JSON.stringify({ noteId, entryId: entry.id })
  },
  onEntryDelete: async (entry) => {
    const noteId = panelContextNoteId()
    if (!noteId) return
    await window.api.analysis.delete(noteId, entry.id)
    closeGraphTabsForEntry(noteId, entry.id)
    const entries = await window.api.analysis.list(noteId)
    if (panelContextNoteId() === noteId) applyPanelEntries(noteId, entries)
  }
})

let writingAboutTimer: ReturnType<typeof setTimeout> | undefined
function scheduleWritingAbout(): void {
  clearTimeout(writingAboutTimer)
  writingAboutTimer = setTimeout(() => {
    panel.updateCurrentParagraph(currentParagraph())
  }, 200)
}

function currentParagraph(): string {
  const state = editor.view.state
  const pos = state.selection.main.head
  const lineNum = state.doc.lineAt(pos).number
  const out: string[] = []
  for (let i = lineNum; i >= 1; i--) {
    const t = state.doc.line(i).text
    if (!t.trim()) break
    out.unshift(t)
  }
  return out.join('\n')
}

const sidebar = mountSidebar({
  rootEl: sidebarEl,
  onOpenNote: (id) => void openInActiveTab(id),
  onBeforeMutate: flushActive,
  onItemMoved,
  onItemDeleted
})

const tabBar = mountTabBar({
  rootEl: tabsEl,
  getTitle: tabTitle,
  // The + button opens an empty new tab (placeholder with "New note / Open existing"),
  // matching ⌘T. Use ⌘N if you want to skip the placeholder and create a note immediately.
  onNewNote: () => void openNewEmptyTab(),
  onSwitch: (idx) => void switchTab(idx),
  onClose: (idx) => void closeTab(idx),
  onReorder: (from, to) => reorderTab(from, to)
})

function reorderTab(from: number, to: number): void {
  if (from === to || from < 0 || from >= tabs.length || to < 0 || to > tabs.length) return
  const [moved] = tabs.splice(from, 1)
  tabs.splice(to, 0, moved)
  if (activeTabIdx === from) activeTabIdx = to
  else if (from < activeTabIdx && to >= activeTabIdx) activeTabIdx--
  else if (from > activeTabIdx && to <= activeTabIdx) activeTabIdx++
  renderTabs()
}

function noteTitleFromId(id: string): string {
  const note = sidebar.notes().find((n) => n.id === id)
  if (note) return note.title
  return id.split('/').pop()?.replace(/\.md$/i, '') ?? 'Untitled'
}

function tabTitle(tab: Tab): string {
  if (tab.kind === 'note') {
    return tab.noteId ? noteTitleFromId(tab.noteId) : 'New tab'
  }
  return `Graph: ${noteTitleFromId(tab.noteId)}`
}

function renderTabs(): void {
  tabBar.render(tabs, activeTabIdx)
}

async function flushActive(): Promise<void> {
  clearTimeout(saveTimer)
  const id = activeId()
  if (id) await window.api.notes.update(id, editor.getContent())
}

// --- graph tab handle: one cytoscape instance reused across graph tabs ---
let graphTabHandle: GraphHandle | null = null
// The entry whose graph is currently mounted, so node-click can resolve a
// node's full info against the right dataset.
let graphTabCurrentEntryNodes: import('./../shared/ipc').AnalysisNode[] = []

function showGraphTabDetail(node: import('./../shared/ipc').AnalysisNode): void {
  graphTabDetailTitleEl.textContent = node.title
  graphTabDetailDescEl.textContent = node.description
  graphTabDetailSourcesEl.replaceChildren()
  for (const src of node.sources) {
    const li = document.createElement('li')
    li.textContent = src
    graphTabDetailSourcesEl.appendChild(li)
  }
  graphTabDetailEl.hidden = false
  // Detail panel can change the graph's available width; nudge cytoscape so
  // the layout doesn't get clipped.
  requestAnimationFrame(() => graphTabHandle?.resize())
}

function hideGraphTabDetail(): void {
  graphTabDetailEl.hidden = true
  requestAnimationFrame(() => graphTabHandle?.resize())
}

graphTabDetailCloseEl.addEventListener('click', hideGraphTabDetail)

async function loadGraphTab(tab: { noteId: string; entryId: string }): Promise<boolean> {
  console.log('[popout] loadGraphTab', tab)
  const entries = await window.api.analysis.list(tab.noteId)
  const entry = entries.find((e) => e.id === tab.entryId)
  console.log('[popout] entries fetched=%d found=%s', entries.length, !!entry)
  if (!entry) {
    console.warn('[popout] entry not in analysis.list — tab will close. ids:', entries.map((e) => e.id))
    return false
  }
  if (!graphTabHandle) {
    console.log('[popout] mounting cytoscape for the first time')
    graphTabHandle = mountGraph(graphTabContainerEl, (id) => {
      const node = graphTabCurrentEntryNodes.find((n) => n.id === id)
      if (node) showGraphTabDetail(node)
    })
  }
  graphTabCurrentEntryNodes = entry.result.nodes
  graphTabHandle.setData(entry.result)
  graphTabTitleEl.textContent = `Graph: ${noteTitleFromId(tab.noteId)}`
  hideGraphTabDetail()
  requestAnimationFrame(() => graphTabHandle?.resize())
  console.log('[popout] loadGraphTab done: %d nodes, %d edges', entry.result.nodes.length, entry.result.edges.length)
  return true
}

async function syncPanelToNote(noteId: string | null, preferEntryId: string | null): Promise<void> {
  if (!noteId) {
    applyPanelEntries(null, [])
    return
  }
  const entries = await window.api.analysis.list(noteId)
  // Tab-switch race guard.
  if (panelContextNoteId() === noteId) applyPanelEntries(noteId, entries, preferEntryId)
}

async function loadActiveTab(): Promise<void> {
  const t = tabs[activeTabIdx]
  if (!t) return
  if (t.kind === 'graph') {
    editorEl.hidden = true
    placeholderEl.hidden = true
    const ok = await loadGraphTab(t)
    if (!ok) {
      // Underlying entry has gone (e.g. deleted). Close the tab and bail.
      tabs.splice(activeTabIdx, 1)
      if (!tabs.length) tabs.push({ kind: 'note', noteId: null })
      if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1
      renderTabs()
      await loadActiveTab()
      return
    }
    graphTabViewEl.hidden = false
    sidebar.setActive(t.noteId)
    // The graph tab IS the analysis view — no need for the side panel here.
    // ⌘E is gated to note tabs too (see keydown handler below).
    panel.hide()
    return
  }
  // 'note' kind
  graphTabViewEl.hidden = true
  if (t.noteId) {
    const md = await window.api.notes.read(t.noteId)
    editor.setContent(md)
    editorEl.hidden = false
    placeholderEl.hidden = true
  } else {
    editor.setContent('')
    editorEl.hidden = true
    placeholderEl.hidden = false
  }
  sidebar.setActive(t.noteId)
  void syncPanelToNote(t.noteId, null)
}

async function openInActiveTab(id: string): Promise<void> {
  await flushActive()
  // If the active slot is a graph tab, treat it like opening in a new tab —
  // graph tabs aren't editing surfaces, so we shouldn't overwrite them.
  if (tabs[activeTabIdx].kind === 'graph') {
    tabs.push({ kind: 'note', noteId: id })
    activeTabIdx = tabs.length - 1
  } else {
    tabs[activeTabIdx] = { kind: 'note', noteId: id }
  }
  await loadActiveTab()
  renderTabs()
}

// Bring the recorded note on screen so the stop press always lands somewhere
// visible: switch to its tab if open, otherwise open it fresh. Never replaces
// the tab the user is looking at.
async function focusNoteTab(noteId: string): Promise<void> {
  const idx = tabs.findIndex((t) => t.kind === 'note' && t.noteId === noteId)
  if (idx !== -1) {
    if (idx !== activeTabIdx) await switchTab(idx)
    return
  }
  await openInNewTab(noteId)
}

async function openInNewTab(id: string): Promise<void> {
  await flushActive()
  tabs.push({ kind: 'note', noteId: id })
  activeTabIdx = tabs.length - 1
  await loadActiveTab()
  renderTabs()
}

async function openGraphInNewTab(noteId: string, entryId: string): Promise<void> {
  console.log('[popout] openGraphInNewTab', { noteId, entryId, currentTabs: tabs.length })
  await flushActive()
  const existing = tabs.findIndex(
    (t) => t.kind === 'graph' && t.noteId === noteId && t.entryId === entryId
  )
  if (existing !== -1) {
    console.log('[popout] reusing existing graph tab at', existing)
    activeTabIdx = existing
    await loadActiveTab()
    renderTabs()
    return
  }
  tabs.push({ kind: 'graph', noteId, entryId })
  activeTabIdx = tabs.length - 1
  console.log('[popout] pushed new graph tab, idx=', activeTabIdx)
  await loadActiveTab()
  renderTabs()
}

function closeGraphTabsForEntry(noteId: string, entryId: string): void {
  let changed = false
  for (let i = tabs.length - 1; i >= 0; i--) {
    const t = tabs[i]
    if (t.kind === 'graph' && t.noteId === noteId && t.entryId === entryId) {
      tabs.splice(i, 1)
      if (i < activeTabIdx) activeTabIdx--
      else if (i === activeTabIdx && activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1
      changed = true
    }
  }
  if (!tabs.length) tabs.push({ kind: 'note', noteId: null })
  if (changed) {
    renderTabs()
    void loadActiveTab()
  }
}

async function switchTab(idx: number): Promise<void> {
  if (idx === activeTabIdx) return
  await flushActive()
  activeTabIdx = idx
  await loadActiveTab()
  renderTabs()
}

async function closeTab(idx: number): Promise<void> {
  if (idx === activeTabIdx) await flushActive()
  const [closed] = tabs.splice(idx, 1)
  if (closed?.kind === 'note' && closed.noteId) {
    closedStack.push(closed.noteId)
    if (closedStack.length > CLOSED_STACK_MAX) closedStack.shift()
  }
  if (!tabs.length) tabs.push({ kind: 'note', noteId: null })
  if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1
  else if (idx < activeTabIdx) activeTabIdx--
  await loadActiveTab()
  renderTabs()
}

async function reopenLastClosedTab(): Promise<void> {
  const known = new Set(sidebar.notes().map((n) => n.id))
  while (closedStack.length) {
    const id = closedStack.pop()!
    if (known.has(id)) {
      await openInNewTab(id)
      return
    }
  }
}

async function createInNewTab(): Promise<void> {
  await flushActive()
  const meta = await window.api.notes.create({})
  await sidebar.refresh()
  tabs.push({ kind: 'note', noteId: meta.id })
  activeTabIdx = tabs.length - 1
  await loadActiveTab()
  renderTabs()
}

async function openNewEmptyTab(): Promise<void> {
  await flushActive()
  tabs.push({ kind: 'note', noteId: null })
  activeTabIdx = tabs.length - 1
  await loadActiveTab()
  renderTabs()
}

async function openWikiTarget(target: string): Promise<void> {
  const want = target.endsWith('.md') ? target : `${target}.md`
  const existing = sidebar
    .notes()
    .find((n) => n.id === want || n.id === target || n.title === target)
  if (existing) return void openInActiveTab(existing.id)
  const meta = await window.api.notes.create({ title: target })
  await sidebar.refresh()
  await openInActiveTab(meta.id)
}

function onItemMoved(oldPath: string, newPath: string): void {
  let changed = false
  for (const tab of tabs) {
    if (tab.kind === 'note') {
      if (!tab.noteId) continue
      if (tab.noteId === oldPath) {
        tab.noteId = newPath
        changed = true
      } else if (tab.noteId.startsWith(`${oldPath}/`)) {
        tab.noteId = newPath + tab.noteId.slice(oldPath.length)
        changed = true
      }
    } else {
      if (tab.noteId === oldPath) {
        tab.noteId = newPath
        changed = true
      } else if (tab.noteId.startsWith(`${oldPath}/`)) {
        tab.noteId = newPath + tab.noteId.slice(oldPath.length)
        changed = true
      }
    }
  }
  if (changed) {
    sidebar.setActive(activeId())
    renderTabs()
  }
}

async function onItemDeleted(path: string): Promise<void> {
  let needsLoad = false
  for (let i = tabs.length - 1; i >= 0; i--) {
    const t = tabs[i]
    const id = t.noteId
    if (id && (id === path || id.startsWith(`${path}/`))) {
      if (i === activeTabIdx) {
        clearTimeout(saveTimer)
        needsLoad = true
      }
      tabs.splice(i, 1)
      if (i < activeTabIdx) activeTabIdx--
    }
  }
  if (!tabs.length) tabs.push({ kind: 'note', noteId: null })
  if (activeTabIdx >= tabs.length) activeTabIdx = tabs.length - 1
  if (needsLoad) await loadActiveTab()
  renderTabs()
}

// When a meeting ends, kick off analysis on the transcript text (per-recording
// entry). The raw transcript itself is kept in the analysis entry's sourceText
// and surfaced via the side panel — no longer dumped into the note's markdown.
// Side panel + loading bar are turned on by onRecordingStopped (fired the moment
// the user clicks Stop) — this function just runs analysis once the transcript
// arrives. If there's no usable text we still need to clear the loading bar.
// The note id is the one pinned when recording started, not whatever tab is
// active now.
function appendTranscript(noteId: string, final: string): void {
  const id = noteId
  console.log('[appendTranscript] start', { id, hasText: !!final.trim(), textLen: final.trim().length })
  if (!id || !final.trim()) {
    panel.setLoading(false)
    return
  }
  const text = final.trim()
  window.api.analysis
    .run(id, text)
    .then(async (entry) => {
      console.log('[appendTranscript] analysis.run resolved', {
        id,
        entryId: entry?.id,
        summaryLen: entry?.result?.summary?.length ?? 0,
        nodes: entry?.result?.nodes?.length ?? 0
      })
      panel.setLoading(false)
      const ctxAfterRun = panelContextNoteId()
      if (ctxAfterRun !== id) {
        console.warn('[appendTranscript] context drift after run', { id, ctxAfterRun })
        return
      }
      const entries = await window.api.analysis.list(id)
      console.log('[appendTranscript] analysis.list resolved', { id, count: entries.length })
      const ctxAfterList = panelContextNoteId()
      if (ctxAfterList !== id) {
        console.warn('[appendTranscript] context drift after list', { id, ctxAfterList })
        return
      }
      applyPanelEntries(id, entries, entry.id)
    })
    .catch((err) => {
      // Without this catch, a rejected analysis.run swallows the error AND leaves
      // the loading bar spinning forever.
      console.error('[appendTranscript] analysis chain failed', err)
      panel.setLoading(false)
    })
}

mountTranscriptionUI({
  popoverEl: recordPopoverEl,
  containerEl: transcriptionEl,
  transcriptEl,
  toggleEl: recordBtn,
  getNoteId: () => activeId() ?? '',
  // Fires the instant the user clicks Stop. Bring the recorded note on screen
  // first (it may have been left behind by a tab switch), then open the panel
  // and turn the loading bar on so the UI feels responsive while the cleanup
  // + analysis calls (a few seconds total) run in the background.
  onRecordingStopped: (noteId) => {
    if (!noteId) return
    void focusNoteTab(noteId).then(() => {
      panel.show()
      panel.setLoading(true)
    })
  },
  onTranscriptReady: appendTranscript
})

// --- Tab bar drop target for graph drag-out from the side panel ---
tabsEl.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(GRAPH_DRAG_MIME)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  tabsEl.classList.add('drop-graph')
})
tabsEl.addEventListener('dragleave', (e) => {
  // Only clear when leaving the tabs container entirely, not when crossing into a child.
  if (!tabsEl.contains(e.relatedTarget as Node | null)) tabsEl.classList.remove('drop-graph')
})
tabsEl.addEventListener('drop', (e) => {
  const raw = e.dataTransfer?.getData(GRAPH_DRAG_MIME)
  tabsEl.classList.remove('drop-graph')
  if (!raw) return
  e.preventDefault()
  try {
    const { noteId, entryId } = JSON.parse(raw) as { noteId?: string; entryId?: string }
    if (noteId && entryId) void openGraphInNewTab(noteId, entryId)
  } catch {
    /* malformed payload — ignore */
  }
})

window.addEventListener('focus', () => void sidebar.refresh().then(renderTabs))

placeholderEl.querySelector('[data-action="new-note"]')?.addEventListener('click', () => {
  void createInNewTab()
})
placeholderEl.querySelector('[data-action="open-existing"]')?.addEventListener('click', () => {
  showNoteSearch(sidebar.notes(), (id) => void openInActiveTab(id))
})

const help = mountHelp()
helpBtn.addEventListener('click', () => help.toggle())

const settings = mountSettings()
settingsBtn.addEventListener('click', () => settings.toggle())

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (!e.shiftKey && key === 'n' && kb.newNote) {
    e.preventDefault()
    void createInNewTab()
  } else if (!e.shiftKey && key === 't' && kb.newTab) {
    e.preventDefault()
    void openNewEmptyTab()
  } else if (e.shiftKey && key === 't' && kb.reopenTab) {
    e.preventDefault()
    void reopenLastClosedTab()
  } else if (!e.shiftKey && key === 'e' && kb.sidePanel) {
    e.preventDefault()
    // ⌘E is a note-context shortcut; suppress it on graph tabs where the
    // side panel is intentionally unavailable.
    if (tabs[activeTabIdx]?.kind === 'note') panel.toggle()
  } else if (!e.shiftKey && key === 'o' && kb.quickOpen) {
    e.preventDefault()
    showNoteSearch(sidebar.notes(), (id) => void openInActiveTab(id))
  } else if (!e.shiftKey && key === '/' && kb.help) {
    e.preventDefault()
    help.toggle()
  } else if (editor.view.hasFocus && !e.shiftKey && key === 'b' && kb.formatBold) {
    e.preventDefault()
    editor.wrapSelection('**')
  } else if (editor.view.hasFocus && !e.shiftKey && key === 'i' && kb.formatItalic) {
    e.preventDefault()
    editor.wrapSelection('*')
  } else if (editor.view.hasFocus && !e.shiftKey && key === 'k' && kb.formatLink) {
    e.preventDefault()
    editor.wrapSelection('[', '](url)')
  } else if (editor.view.hasFocus && e.shiftKey && key === 'c' && kb.formatCode) {
    e.preventDefault()
    editor.wrapSelection('`')
  } else if (editor.view.hasFocus && e.shiftKey && key === 's' && kb.formatStrike) {
    e.preventDefault()
    editor.wrapSelection('~~')
  }
})

window.api.editor.onCloseTab(() => void closeTab(activeTabIdx))

async function init(): Promise<void> {
  await sidebar.refresh()
  const notes = sidebar.notes()
  if (notes.length) {
    tabs[0] = { kind: 'note', noteId: notes[0].id }
    await loadActiveTab()
  } else {
    const meta = await window.api.notes.create({})
    await sidebar.refresh()
    tabs[0] = { kind: 'note', noteId: meta.id }
    await loadActiveTab()
  }
  renderTabs()
  // Launch onboarding: surface the help modal on first launch only. markSeen
  // flips the stored flag so later launches stay quiet; the checkbox inside
  // the modal still lets the user turn the reminder back on.
  if (shouldShowHelpOnLaunch()) {
    help.open()
    help.markSeen()
  }
}

void init()
