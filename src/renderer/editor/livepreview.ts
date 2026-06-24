// Obsidian-style "Live Preview" for CodeMirror 6: render markdown in place instead
// of in a separate pane. A construct shows its rendered form unless a selection
// overlaps it, in which case the raw markdown is revealed so you can edit it.
//
// Two strategies:
//   - mark + hide-markers (text stays editable inline): headings, bold, italic, code.
//   - replace-with-widget (atomic rendered element): links, images, $math$, [[wikilinks]].
//
// Decorations come from a StateField (NOT a ViewPlugin): block widgets (display math)
// and replace decorations that span line breaks are categorically rejected by CM6 when
// supplied from a plugin, so a StateField is required for $$…$$ to render without throwing.
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNodeRef } from '@lezer/common'
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { WIKILINK_RE } from './wikilink'

export interface LivePreviewOptions {
  onOpenNote?: (target: string) => void
}

const IMG_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/
// Obsidian-flavor sizing: a trailing `|W` or `|WxH` on the alt text. Parsed
// separately from IMG_RE so any pipe that ISN'T followed by digits is left as alt.
const IMG_SIZE_RE = /^(.*)\|(\d+)(?:x(\d+))?$/
const LINK_RE = /^\[([^\]]*)\]\(([^)]+)\)$/
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:)/i

interface ParsedImage {
  alt: string
  src: string
  width: number | undefined
  height: number | undefined
}

function parseImage(text: string): ParsedImage | null {
  const m = IMG_RE.exec(text)
  if (!m) return null
  let alt = m[1]
  let width: number | undefined
  let height: number | undefined
  const s = IMG_SIZE_RE.exec(alt)
  if (s) {
    alt = s[1]
    width = parseInt(s[2], 10)
    height = s[3] !== undefined ? parseInt(s[3], 10) : undefined
  }
  return { alt, src: m[2], width, height }
}

// Map a vault-relative image path to the privileged memry:// scheme (mirrors main/protocol.ts).
function resolveSrc(src: string): string {
  if (EXTERNAL_RE.test(src) || src.startsWith('/')) return src
  return `memry://vault/${src.replace(/^\.?\//, '')}`
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | undefined,
    readonly height: number | undefined
  ) {
    super()
  }
  eq(o: ImageWidget): boolean {
    return (
      o.src === this.src &&
      o.alt === this.alt &&
      o.width === this.width &&
      o.height === this.height
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image-wrap'
    const img = document.createElement('img')
    img.className = 'cm-rendered-image'
    img.src = this.src
    img.alt = this.alt
    if (this.width !== undefined) img.style.width = `${this.width}px`
    if (this.height !== undefined) img.style.height = `${this.height}px`
    wrap.appendChild(img)

    const handle = document.createElement('span')
    handle.className = 'cm-image-resize-handle'
    handle.title = 'Drag to resize'
    handle.addEventListener('mousedown', (e) => startResize(e, view, wrap, img))
    wrap.appendChild(handle)
    return wrap
  }
  ignoreEvent(e: Event): boolean {
    // The handle's own mousedown handler steers the resize; let it through without
    // CM6 also reacting (which would move the caret into the image's source range).
    if (
      e.type === 'mousedown' &&
      (e.target as HTMLElement | null)?.classList.contains('cm-image-resize-handle')
    ) {
      return true
    }
    return false
  }
}

// Drag the corner of a rendered image to resize. Live-updates the DOM during drag
// for instant feedback; on release, rewrites the markdown source so the new size
// becomes the `|W` portion of the alt text (Obsidian convention).
function startResize(
  e: MouseEvent,
  view: EditorView,
  wrap: HTMLElement,
  img: HTMLImageElement
): void {
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startW = img.getBoundingClientRect().width
  const aspect =
    img.naturalWidth > 0 && img.naturalHeight > 0
      ? img.naturalHeight / img.naturalWidth
      : null

  wrap.classList.add('cm-image-resizing')

  const onMove = (ev: MouseEvent): void => {
    const dx = ev.clientX - startX
    const newW = Math.max(40, Math.round(startW + dx))
    img.style.width = `${newW}px`
    if (aspect !== null) img.style.height = `${Math.round(newW * aspect)}px`
  }

  const onUp = (ev: MouseEvent): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    wrap.classList.remove('cm-image-resizing')

    const dx = ev.clientX - startX
    const newW = Math.max(40, Math.round(startW + dx))

    // Find this image's source range via the widget DOM's current doc position —
    // robust against doc edits made before the resize finished.
    const pos = view.posAtDOM(wrap)
    if (pos == null || pos < 0) return
    let from = -1
    let to = -1
    syntaxTree(view.state).iterate({
      from: pos,
      to: pos + 1,
      enter: (node) => {
        if (node.name === 'Image' && from === -1) {
          from = node.from
          to = node.to
        }
      }
    })
    if (from < 0) return
    const parsed = parseImage(view.state.doc.sliceString(from, to))
    if (!parsed) return
    const altWithSize = parsed.alt ? `${parsed.alt}|${newW}` : `|${newW}`
    const newText = `![${altWithSize}](${parsed.src})`
    view.dispatch({ changes: { from, to, insert: newText } })
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean
  ) {
    super()
  }
  eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.display ? 'cm-rendered-math cm-math-block' : 'cm-rendered-math'
    span.innerHTML = katex.renderToString(this.tex, {
      throwOnError: false,
      displayMode: this.display
    })
    return span
  }
}

class LinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly href: string
  ) {
    super()
  }
  eq(o: LinkWidget): boolean {
    return o.text === this.text && o.href === this.href
  }
  toDOM(): HTMLElement {
    const a = document.createElement('span')
    a.className = 'cm-rendered-link'
    a.textContent = this.text
    a.setAttribute('data-href', this.href)
    return a
  }
}

class WikiWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly display: string
  ) {
    super()
  }
  eq(o: WikiWidget): boolean {
    return o.target === this.target && o.display === this.display
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-rendered-wikilink'
    span.textContent = this.display
    span.setAttribute('data-wikilink', this.target)
    return span
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const decos: Range<Decoration>[] = []
  const ranges = state.selection.ranges

  // A construct is "active" (show source) when any selection overlaps its span.
  const active = (from: number, to: number): boolean =>
    ranges.some((r) => r.from <= to && r.to >= from)

  const styledInline = (
    from: number,
    to: number,
    cls: string,
    markName: string,
    node: SyntaxNodeRef
  ): void => {
    decos.push(Decoration.mark({ class: cls }).range(from, to))
    if (!active(from, to)) {
      for (const m of node.node.getChildren(markName)) {
        if (m.to > m.from) decos.push(Decoration.replace({}).range(m.from, m.to))
      }
    }
  }

  // --- markdown tree constructs ---
  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      const name = node.name
      if (/^ATXHeading[1-6]$/.test(name)) {
        const level = Number(name.slice(-1))
        const line = doc.lineAt(node.from)
        decos.push(Decoration.line({ class: `cm-h${level}` }).range(line.from))
        if (!active(node.from, node.to)) {
          const m = /^#{1,6}\s+/.exec(line.text)
          if (m) decos.push(Decoration.replace({}).range(line.from, line.from + m[0].length))
        }
      } else if (name === 'StrongEmphasis') {
        styledInline(node.from, node.to, 'cm-strong', 'EmphasisMark', node)
      } else if (name === 'Emphasis') {
        styledInline(node.from, node.to, 'cm-em', 'EmphasisMark', node)
      } else if (name === 'InlineCode') {
        styledInline(node.from, node.to, 'cm-inline-code', 'CodeMark', node)
      } else if (name === 'Image') {
        if (active(node.from, node.to)) return
        const parsed = parseImage(doc.sliceString(node.from, node.to))
        if (parsed) {
          decos.push(
            Decoration.replace({
              widget: new ImageWidget(
                resolveSrc(parsed.src),
                parsed.alt,
                parsed.width,
                parsed.height
              )
            }).range(node.from, node.to)
          )
        }
      } else if (name === 'Link') {
        if (active(node.from, node.to)) return
        const m = LINK_RE.exec(doc.sliceString(node.from, node.to))
        if (m) {
          decos.push(
            Decoration.replace({ widget: new LinkWidget(m[1], m[2]) }).range(node.from, node.to)
          )
        }
      }
    }
  })

  // --- math (regex; lang-markdown does not parse $) over the whole doc ---
  const text = doc.toString()
  const blockRanges: [number, number][] = []
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const from = m.index!
    const to = from + m[0].length
    blockRanges.push([from, to])
    if (active(from, to)) continue
    const tex = m[1].trim()
    if (!tex) continue
    const lineFrom = doc.lineAt(from)
    const lineTo = doc.lineAt(to)
    const isBlock = from === lineFrom.from && to === lineTo.to
    decos.push(
      Decoration.replace({ widget: new MathWidget(tex, true), block: isBlock }).range(from, to)
    )
  }
  const inBlock = (i: number): boolean => blockRanges.some(([a, b]) => i >= a && i < b)
  // Word-boundary-ish guards so adjacent currency ("$5-$10") isn't mistaken for math.
  for (const m of text.matchAll(/(?<![\w$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g)) {
    const from = m.index!
    if (inBlock(from)) continue
    const to = from + m[0].length
    if (active(from, to)) continue
    decos.push(Decoration.replace({ widget: new MathWidget(m[1].trim(), false) }).range(from, to))
  }

  // --- wikilinks (regex; WIKILINK_RE is single-line so the range never spans a break) ---
  for (const m of text.matchAll(WIKILINK_RE)) {
    const from = m.index!
    const to = from + m[0].length
    if (active(from, to)) continue
    const target = m[1].trim()
    if (!target) continue
    const display = (m[2] ?? m[1]).trim()
    decos.push(Decoration.replace({ widget: new WikiWidget(target, display) }).range(from, to))
  }

  return Decoration.set(decos, true)
}

export function livePreview(opts: LivePreviewOptions = {}): Extension {
  // StateField (not ViewPlugin) so block / line-break-spanning replace decorations are legal.
  const field = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? buildDecorations(tr.state) : value.map(tr.changes),
    provide: (f) => EditorView.decorations.from(f)
  })

  // Clicking a rendered wikilink opens the note; a rendered link opens externally.
  const clicks = EditorView.domEventHandlers({
    mousedown: (e) => {
      const el = (e.target as HTMLElement)?.closest('[data-wikilink],[data-href]') as
        | HTMLElement
        | null
      if (!el) return false
      const target = el.getAttribute('data-wikilink')
      if (target) {
        e.preventDefault()
        opts.onOpenNote?.(target)
        return true
      }
      const href = el.getAttribute('data-href')
      if (href) {
        e.preventDefault()
        window.open(href, '_blank')
        return true
      }
      return false
    }
  })

  return [field, clicks]
}
