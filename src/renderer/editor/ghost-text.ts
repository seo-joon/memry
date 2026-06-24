// CM6 ghost-text inline suggestions. Pattern:
//   - StateField holds the current pending suggestion {text, pos}.
//   - Decoration.widget renders the muted span after the cursor.
//   - ViewPlugin debounces a request callback after every doc change.
//   - Tab inserts the suggestion; any other key (including caret movement)
//     drops it via the field's `tr.docChanged || tr.selection` clear branch.
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

type Pending = { text: string; pos: number }

const setSuggestion = StateEffect.define<Pending | null>()

const suggestionState = StateField.define<Pending | null>({
  create: () => null,
  update(value, tr) {
    // setSuggestion always wins — covers our own accept/clear dispatches.
    for (const e of tr.effects) if (e.is(setSuggestion)) return e.value
    // Any other change to the document or selection invalidates the ghost.
    if (tr.docChanged || tr.selection) return null
    return value
  }
})

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ghost-text'
    span.textContent = this.text
    return span
  }
  eq(other: GhostTextWidget): boolean {
    return other.text === this.text
  }
}

const ghostTextDecoration = EditorView.decorations.compute([suggestionState], (state) => {
  const s = state.field(suggestionState)
  if (!s) return Decoration.none
  return Decoration.set([
    Decoration.widget({ widget: new GhostTextWidget(s.text), side: 1 }).range(s.pos)
  ])
})

function acceptGhostText(view: EditorView): boolean {
  const s = view.state.field(suggestionState)
  if (!s) return false
  view.dispatch({
    changes: { from: s.pos, insert: s.text },
    selection: { anchor: s.pos + s.text.length },
    effects: setSuggestion.of(null)
  })
  return true
}

function dismissGhostText(view: EditorView): boolean {
  if (!view.state.field(suggestionState)) return false
  view.dispatch({ effects: setSuggestion.of(null) })
  return true
}

// Walk backwards from the current line until we hit a blank line; that block
// is the "paragraph" we feed to the model as context for the continuation.
function getParagraph(state: EditorState, lineNum: number): string {
  const out: string[] = []
  for (let i = lineNum; i >= 1; i--) {
    const t = state.doc.line(i).text
    if (!t.trim()) break
    out.unshift(t)
  }
  return out.join('\n')
}

export interface GhostTextOptions {
  request: (paragraph: string) => Promise<string>
  debounceMs?: number
}

export function ghostText(opts: GhostTextOptions): Extension {
  const debounceMs = opts.debounceMs ?? 500

  const requester = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      // Monotonic seq: discard stale fetches if the doc moved on.
      seq = 0
      lastQuery = ''

      update(u: ViewUpdate): void {
        if (!u.docChanged) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.fire(u.view), debounceMs)
      }

      async fire(view: EditorView): Promise<void> {
        const { state } = view
        const pos = state.selection.main.head
        const line = state.doc.lineAt(pos)
        // Only trigger when the cursor is at the end of a non-empty line that
        // ends with whitespace — i.e. the user just finished a word and either
        // tapped space or paused mid-thought after one. Mid-word pauses get
        // skipped so we don't fire while they're still picking a word.
        if (pos !== line.to) return
        if (!line.text.trim()) return
        if (!/\s$/.test(line.text)) return

        const paragraph = getParagraph(state, line.number)
        if (paragraph === this.lastQuery) return
        this.lastQuery = paragraph

        const mySeq = ++this.seq
        const raw = await opts.request(paragraph)
        if (mySeq !== this.seq) return
        if (!raw) return

        // Single-line ghost text only — multi-line suggestions are noisy and
        // mess with line height.
        const cleaned = raw.split('\n')[0]?.trim() ?? ''
        if (!cleaned) return

        // Re-validate the cursor is still where we asked from. If the user
        // kept typing in the gap, abandon this suggestion.
        const live = view.state
        if (live.selection.main.head !== pos) return
        if (live.doc.lineAt(pos).text !== line.text) return

        view.dispatch({ effects: setSuggestion.of({ text: cleaned, pos }) })
      }

      destroy(): void {
        if (this.timer) clearTimeout(this.timer)
      }
    }
  )

  return [
    suggestionState,
    ghostTextDecoration,
    requester,
    // Tab/Escape only consume the key when a ghost is actually pending — false
    // lets them fall through to indent/normal behavior the rest of the time.
    keymap.of([
      { key: 'Tab', run: acceptGhostText },
      { key: 'Escape', run: dismissGhostText }
    ])
  ]
}
