// CM6 extension: clipboard paste + filesystem drag-drop of image files. Each image
// is sent to the main process (which writes it to the vault root) and the returned
// path is inserted at the cursor as a standard markdown image. The live-preview
// extension then renders it inline via the memry:// protocol.
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface ImagePasteOptions {
  // (filename, base64) => relative path the asset was saved at (collision-deduped).
  writeAsset: (filename: string, base64: string) => Promise<string>
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function timestamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function extFromType(mime: string): string {
  const m = /^image\/([a-z0-9.+-]+)/i.exec(mime)
  if (!m) return '.png'
  const sub = m[1].toLowerCase()
  if (sub === 'jpeg') return '.jpg'
  if (sub === 'svg+xml') return '.svg'
  return `.${sub}`
}

// Percent-encode each path segment so spaces and other reserved chars become
// CommonMark-legal inside `![](…)`. Without this, a filename like `Screenshot 2026-…`
// is rejected by lang-markdown's image parser and the live preview never renders.
function encodePathForMarkdown(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/')
}

// Encode in 32KB chunks so a large image doesn't blow the call stack via spread.
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const u8 = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)))
  }
  return btoa(bin)
}

export function imagePaste(opts: ImagePasteOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const items = event.clipboardData?.items
      if (!items) return false
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue
        const file = it.getAsFile()
        if (!file) continue
        event.preventDefault()
        const filename = `Pasted image ${timestamp()}${extFromType(file.type)}`
        void (async () => {
          const base64 = await blobToBase64(file)
          const rel = await opts.writeAsset(filename, base64)
          const md = `![](${encodePathForMarkdown(rel)})`
          const sel = view.state.selection.main
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: md },
            selection: { anchor: sel.from + md.length }
          })
        })()
        return true
      }
      return false
    },

    dragover(event) {
      // Only opt-in when files are being dragged — drop on text drags is CM6's job.
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) {
        return false
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      return true
    },

    drop(event, view) {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return false
      const images: File[] = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        if (f.type.startsWith('image/')) images.push(f)
      }
      if (images.length === 0) return false
      event.preventDefault()
      // Insert at the drop location; if the position lookup fails, fall back to the cursor.
      const dropPos =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
        view.state.selection.main.head
      void (async () => {
        let cursor = dropPos
        for (const f of images) {
          const filename = f.name || `Dropped image ${timestamp()}${extFromType(f.type)}`
          const base64 = await blobToBase64(f)
          const rel = await opts.writeAsset(filename, base64)
          const md = `![](${encodePathForMarkdown(rel)})\n`
          view.dispatch({ changes: { from: cursor, insert: md } })
          cursor += md.length
        }
      })()
      return true
    }
  })
}
