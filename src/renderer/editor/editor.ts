import { Annotation, Compartment, EditorState, EditorSelection, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, type KeyBinding } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { livePreview } from './livepreview'
import { ghostText, type GhostTextOptions } from './ghost-text'
import { imagePaste, type ImagePasteOptions } from './image-paste'

// Dark CodeMirror surface: the chrome flips via CSS vars, but the caret and
// content color come from CodeMirror's own base theme, so they need an
// explicit dark variant. `{ dark: true }` also gives us the darker default
// selection. Toggled through a compartment — no editor rebuild.
const darkCodeTheme = EditorView.theme(
  {
    '&': { color: 'var(--text)' },
    '.cm-content': { caretColor: 'var(--text)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' }
  },
  { dark: true }
)

// Marks a programmatic content load (disk read) so the change doesn't fire onChange
// and trigger an autosave of the note's own just-loaded content.
const externalLoad = Annotation.define<boolean>()
const themeCompartment = new Compartment()

export interface EditorHandle {
  view: EditorView
  getContent(): string
  setContent(md: string): void
  setTheme(dark: boolean): void
  wrapSelection(before: string, after?: string): void
  appendBlock(text: string): void
  destroy(): void
}

export interface CreateEditorOptions {
  initial?: string
  onChange?: (doc: string) => void
  // Fires when the caret moves without the doc changing. Kept separate from
  // onChange so cursor movement doesn't trigger a disk save.
  onCaretMove?: () => void
  onOpenNote?: (target: string) => void
  // Default true. Pass false for compact surfaces (stickies) that don't want a gutter.
  lineNumbers?: boolean
  // Bindings inserted BEFORE defaultKeymap so they take precedence — used by the
  // sticky to override Mod-Enter (which would otherwise insert a newline) into a
  // "close window" action.
  extraKeymap?: readonly KeyBinding[]
  // Enables inline ghost-text suggestions (passes through to ghost-text.ts).
  ghostText?: GhostTextOptions
  // Enables clipboard paste + file drop of images. Saves to the vault, inserts ![](path).
  imagePaste?: ImagePasteOptions
}

export function createEditor(parent: HTMLElement, opts: CreateEditorOptions): EditorHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.initial ?? '',
      extensions: [
        history(),
        ...(opts.extraKeymap ? [keymap.of([...opts.extraKeymap])] : []),
        // Ghost-text BEFORE defaultKeymap so its Tab/Escape bindings take
        // precedence when a suggestion is pending.
        ...(opts.ghostText ? [ghostText(opts.ghostText)] : []),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...(opts.lineNumbers === false ? [] : [lineNumbers()]),
        markdown(),
        livePreview({ onOpenNote: opts.onOpenNote }),
        ...(opts.imagePaste ? [imagePaste(opts.imagePaste)] : []),
        themeCompartment.of([]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((t) => t.annotation(externalLoad))) {
            opts.onChange?.(u.state.doc.toString())
          }
          if (u.selectionSet) opts.onCaretMove?.()
        })
      ]
    })
  })

  const getContent = () => view.state.doc.toString()

  // Disk loads replace the whole doc without polluting undo history.
  const setContent = (md: string) => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: md },
      annotations: [Transaction.addToHistory.of(false), externalLoad.of(true)]
    })
  }

  // DRY primitive for bold/italic/code toolbar buttons.
  const wrapSelection = (before: string, after: string = before) => {
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after }
        ],
        // Re-select the original text, shifted past the inserted prefix.
        range: EditorSelection.range(range.from + before.length, range.to + before.length)
      }))
    )
    view.focus()
  }

  // Append text to the end of the document (used to land a finished transcript in the note).
  const appendBlock = (text: string) => {
    const end = view.state.doc.length
    view.dispatch({ changes: { from: end, insert: text } })
  }

  // Theme flip without a rebuild: the compartment swaps the dark CodeMirror
  // surface in and out.
  const setTheme = (dark: boolean): void => {
    view.dispatch({ effects: themeCompartment.reconfigure(dark ? darkCodeTheme : []) })
  }

  return { view, getContent, setContent, setTheme, wrapSelection, appendBlock, destroy: () => view.destroy() }
}
