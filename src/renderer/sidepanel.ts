// The right-side analysis panel: a history dropdown over per-recording entries,
// a collapsible summary / writing-about / graph stack, and a node-detail card.
// All three sections share the active AnalysisEntry's result; switching the
// dropdown swaps results without any LLM call.
import type { AnalysisEntry, AnalysisNode } from '../shared/ipc'
import { mountGraph, type GraphHandle } from './graph'

export interface SidePanelOptions {
  // Called when the user clicks ↻. The active entry is passed in so the caller
  // can re-run analysis on its source text.
  onReanalyze?: (entry: AnalysisEntry) => Promise<void>
  // Called when the user clicks the ↗ button on the graph section.
  onGraphPopout?: (entry: AnalysisEntry) => void
  // Called on dragstart from the graph drag handle. Returns a payload string
  // the caller wants stuffed into the drag's text/x-memry-graph mime — usually
  // a JSON of (noteId, entryId) so the drop target knows what to spawn.
  onGraphDragPayload?: (entry: AnalysisEntry) => string | null
  // Called when the user clicks the delete (🗑) button next to the history dropdown.
  onEntryDelete?: (entry: AnalysisEntry) => Promise<void>
}

export interface SidePanelHandle {
  setEntries(entries: AnalysisEntry[], preferActiveId?: string | null): void
  setActiveEntry(id: string | null): void
  getActiveEntry(): AnalysisEntry | null
  updateCurrentParagraph(paragraph: string): void
  setLoading(loading: boolean): void
  show(): void
  hide(): void
  toggle(): void
  isOpen(): boolean
}

const KEYWORD_MIN = 4
const COLLAPSE_KEY = (name: string): string => `memry.section.${name}.collapsed`
const GRAPH_DRAG_MIME = 'text/x-memry-graph'

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= KEYWORD_MIN)
  )
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms)
  const dd = pad2(d.getDate())
  const mm = pad2(d.getMonth() + 1)
  const yy = pad2(d.getFullYear() % 100)
  const hh = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  return `${dd}/${mm}/${yy} ${hh}:${mi}`
}

export function mountSidePanel(opts: SidePanelOptions = {}): SidePanelHandle {
  const app = document.getElementById('app') as HTMLElement
  const panel = document.getElementById('side-panel') as HTMLElement

  const sectionEl = (name: string): HTMLElement =>
    panel.querySelector(`[data-section="${name}"]`) as HTMLElement
  const emptyOf = (sec: HTMLElement): HTMLElement => sec.querySelector('[data-empty]') as HTMLElement
  const contentOf = (sec: HTMLElement): HTMLElement => sec.querySelector('[data-content]') as HTMLElement

  const summarySec = sectionEl('summary')
  const writingSec = sectionEl('writing-about')
  const graphSec = sectionEl('graph')
  const detailSec = sectionEl('node-detail')
  const transcriptSec = sectionEl('transcript')

  const summaryEmpty = emptyOf(summarySec)
  const summaryContent = contentOf(summarySec)
  const writingEmpty = emptyOf(writingSec)
  const writingContent = contentOf(writingSec)
  const graphEmpty = emptyOf(graphSec)
  const graphContainer = document.getElementById('graph-container') as HTMLElement
  const transcriptEmpty = emptyOf(transcriptSec)
  const transcriptContent = contentOf(transcriptSec)

  const detailTitle = detailSec.querySelector('[data-node-title]') as HTMLElement
  const detailDesc = detailSec.querySelector('[data-node-description]') as HTMLElement
  const detailSources = detailSec.querySelector('[data-node-sources]') as HTMLElement
  const detailCloseBtn = detailSec.querySelector('.node-detail-close') as HTMLButtonElement
  const panelCloseBtn = panel.querySelector('.panel-close') as HTMLButtonElement
  const reanalyzeBtn = panel.querySelector('.panel-reanalyze') as HTMLButtonElement

  const historyRow = panel.querySelector('[data-history]') as HTMLElement
  const historySelect = panel.querySelector('[data-history-select]') as HTMLSelectElement
  const historyDelete = panel.querySelector('[data-history-delete]') as HTMLButtonElement

  const graphPopoutBtn = graphSec.querySelector('[data-graph-popout]') as HTMLButtonElement
  const graphDragEl = graphSec.querySelector('[data-graph-drag]') as HTMLElement
  const loadingBar = panel.querySelector('[data-loading-bar]') as HTMLElement

  let entries: AnalysisEntry[] = []
  let activeId: string | null = null
  let graph: GraphHandle | null = null

  function activeEntry(): AnalysisEntry | null {
    return entries.find((e) => e.id === activeId) ?? null
  }

  // The transcript can be long, so default it to collapsed on first run.
  // Subsequent toggles persist normally via the loop below.
  if (localStorage.getItem(COLLAPSE_KEY('transcript')) === null) {
    localStorage.setItem(COLLAPSE_KEY('transcript'), 'true')
  }

  // --- collapsible section wiring (persisted per section) ---
  panel.querySelectorAll<HTMLElement>('.panel-section--collapsible').forEach((sec) => {
    const name = sec.dataset.section!
    if (localStorage.getItem(COLLAPSE_KEY(name)) === 'true') {
      sec.classList.add('panel-section--collapsed')
    }
    const toggleBtn = sec.querySelector<HTMLButtonElement>('[data-section-toggle]')
    toggleBtn?.addEventListener('click', () => {
      const collapsed = sec.classList.toggle('panel-section--collapsed')
      localStorage.setItem(COLLAPSE_KEY(name), String(collapsed))
      // Cytoscape's canvas is sized to its container; on re-expand we need a
      // resize tick so the graph re-fits to the now-visible area.
      if (!collapsed && name === 'graph') {
        requestAnimationFrame(() => graph?.resize())
      }
    })
  })

  function showNodeDetail(node: AnalysisNode): void {
    detailTitle.textContent = node.title
    detailDesc.textContent = node.description
    detailSources.replaceChildren()
    for (const src of node.sources) {
      const li = document.createElement('li')
      li.textContent = src
      detailSources.appendChild(li)
    }
    detailSec.hidden = false
    detailSec.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  detailCloseBtn.addEventListener('click', () => {
    detailSec.hidden = true
  })
  panelCloseBtn.addEventListener('click', () => hide())

  reanalyzeBtn.addEventListener('click', async () => {
    const entry = activeEntry()
    if (!entry || !opts.onReanalyze) return
    // Legacy/migrated entries have no source text — re-running them would just
    // analyze an empty string, so we just bail.
    if (!entry.sourceText) return
    reanalyzeBtn.disabled = true
    try {
      await opts.onReanalyze(entry)
    } finally {
      reanalyzeBtn.disabled = false
    }
  })

  historySelect.addEventListener('change', () => {
    setActiveEntry(historySelect.value || null)
  })

  historyDelete.addEventListener('click', async () => {
    const entry = activeEntry()
    if (!entry || !opts.onEntryDelete) return
    historyDelete.disabled = true
    try {
      await opts.onEntryDelete(entry)
    } finally {
      historyDelete.disabled = false
    }
  })

  graphPopoutBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const entry = activeEntry()
    console.log('[popout] click. activeId=%s entries=%d entry=%s', activeId, entries.length, entry?.id)
    if (!entry) return
    if (!opts.onGraphPopout) {
      console.warn('[popout] no onGraphPopout handler registered')
      return
    }
    opts.onGraphPopout(entry)
  })

  graphDragEl.addEventListener('dragstart', (e: DragEvent) => {
    const entry = activeEntry()
    if (!entry || !e.dataTransfer) {
      e.preventDefault()
      return
    }
    const payload = opts.onGraphDragPayload?.(entry) ?? entry.id
    e.dataTransfer.setData(GRAPH_DRAG_MIME, payload)
    e.dataTransfer.effectAllowed = 'copy'
  })

  function renderSummary(): void {
    const s = activeEntry()?.result.summary?.trim()
    if (!s) {
      summaryEmpty.hidden = false
      summaryContent.hidden = true
      return
    }
    summaryEmpty.hidden = true
    summaryContent.hidden = false
    summaryContent.replaceChildren()
    const p = document.createElement('p')
    p.textContent = s
    summaryContent.appendChild(p)
  }

  function renderGraph(): void {
    const result = activeEntry()?.result
    const nodes = result?.nodes ?? []
    if (!result || !nodes.length) {
      graphEmpty.hidden = false
      graphContainer.hidden = true
      return
    }
    graphEmpty.hidden = true
    graphContainer.hidden = false
    if (!graph) {
      graph = mountGraph(graphContainer, (id) => {
        const n = activeEntry()?.result.nodes.find((x) => x.id === id)
        if (n) showNodeDetail(n)
      })
    }
    graph.setData(result)
  }

  function renderWritingAbout(paragraph: string): void {
    const nodes = activeEntry()?.result.nodes ?? []
    if (!nodes.length || !paragraph.trim()) {
      writingEmpty.hidden = false
      writingContent.hidden = true
      return
    }
    const tokens = tokenize(paragraph)
    const lowerPara = paragraph.toLowerCase()
    const matches = nodes.filter((n) => {
      if (lowerPara.includes(n.title.toLowerCase())) return true
      const titleTokens = tokenize(n.title)
      for (const t of titleTokens) if (tokens.has(t)) return true
      return false
    })
    if (!matches.length) {
      writingEmpty.hidden = false
      writingContent.hidden = true
      return
    }
    writingEmpty.hidden = true
    writingContent.hidden = false
    writingContent.replaceChildren()
    const ul = document.createElement('ul')
    ul.className = 'writing-about-list'
    for (const n of matches) {
      const li = document.createElement('li')
      li.className = 'writing-about-item'
      li.addEventListener('click', () => showNodeDetail(n))
      const t = document.createElement('div')
      t.className = 'writing-about-item-title'
      t.textContent = n.title
      const d = document.createElement('div')
      d.className = 'writing-about-item-desc'
      d.textContent = n.description
      li.append(t, d)
      ul.appendChild(li)
    }
    writingContent.appendChild(ul)
  }

  function renderHistory(): void {
    historyRow.hidden = entries.length === 0
    historySelect.replaceChildren()
    // Newest first reads more naturally — the latest recording is what the
    // user just produced and most likely wants to look at.
    const ordered = [...entries].sort((a, b) => b.createdAt - a.createdAt)
    for (const e of ordered) {
      const opt = document.createElement('option')
      opt.value = e.id
      opt.textContent = formatTimestamp(e.createdAt)
      // The summary preview is still useful, but it bloats the dropdown when
      // shown inline — tuck it into the hover tooltip instead.
      if (e.label && e.label !== 'Analysis') opt.title = e.label
      historySelect.appendChild(opt)
    }
    if (activeId) historySelect.value = activeId
    const canDelete = entries.length > 0 && !!opts.onEntryDelete
    historyDelete.hidden = !canDelete
    const entry = activeEntry()
    reanalyzeBtn.disabled = !entry || !entry.sourceText
  }

  function renderTranscript(): void {
    const text = activeEntry()?.sourceText?.trim()
    if (!text) {
      transcriptEmpty.textContent = activeEntry()
        ? 'No transcript stored for this entry.'
        : 'Record a meeting to see its transcript.'
      transcriptEmpty.hidden = false
      transcriptContent.hidden = true
      transcriptContent.textContent = ''
      return
    }
    transcriptEmpty.hidden = true
    transcriptContent.hidden = false
    transcriptContent.textContent = text
  }

  function renderActive(): void {
    renderSummary()
    renderGraph()
    renderTranscript()
    // Writing-about clears until the caller pushes a fresh paragraph.
    writingEmpty.hidden = false
    writingContent.hidden = true
    detailSec.hidden = true
  }

  function setEntries(next: AnalysisEntry[], preferActiveId?: string | null): void {
    console.log('[sidepanel] setEntries:', {
      count: next.length,
      preferActiveId,
      preview: next.map((e) => ({ id: e.id, summaryLen: e.result.summary?.length ?? 0, nodes: e.result.nodes.length }))
    })
    entries = next
    // Default selection: keep the previously-active id if still present,
    // honor explicit preference, otherwise pick the newest.
    const newest = entries.length
      ? [...entries].sort((a, b) => b.createdAt - a.createdAt)[0].id
      : null
    if (preferActiveId && entries.some((e) => e.id === preferActiveId)) {
      activeId = preferActiveId
    } else if (activeId && entries.some((e) => e.id === activeId)) {
      // keep current
    } else {
      activeId = newest
    }
    renderHistory()
    renderActive()
  }

  function setActiveEntry(id: string | null): void {
    if (id && !entries.some((e) => e.id === id)) return
    activeId = id
    renderHistory()
    renderActive()
  }

  function setLoading(loading: boolean): void {
    loadingBar.hidden = !loading
    summaryEmpty.textContent = loading
      ? 'Analyzing transcript…'
      : 'Record a meeting to generate a summary.'
    graphEmpty.textContent = loading
      ? 'Analyzing transcript…'
      : 'Topic map appears after analysis.'
    if (loading) {
      summaryEmpty.hidden = false
      summaryContent.hidden = true
      graphEmpty.hidden = false
      graphContainer.hidden = true
      // Force-expand sections so the user sees the result land. They can re-
      // collapse manually after; we don't persist this override. Skip transcript —
      // it can be huge and the user explicitly opts in to seeing it.
      panel.querySelectorAll<HTMLElement>('.panel-section--collapsed').forEach((sec) => {
        if (sec.dataset.section === 'transcript') return
        sec.classList.remove('panel-section--collapsed')
      })
    }
  }

  function show(): void {
    panel.hidden = false
    app.classList.add('side-open')
    requestAnimationFrame(() => graph?.resize())
  }

  function hide(): void {
    app.classList.remove('side-open')
    panel.hidden = true
  }

  function toggle(): void {
    if (panel.hidden) show()
    else hide()
  }

  function isOpen(): boolean {
    return !panel.hidden
  }

  return {
    setEntries,
    setActiveEntry,
    getActiveEntry: activeEntry,
    updateCurrentParagraph: renderWritingAbout,
    setLoading,
    show,
    hide,
    toggle,
    isOpen
  }
}

export { GRAPH_DRAG_MIME }
