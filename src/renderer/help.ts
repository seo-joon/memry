// A scrollable help modal: keyboard shortcuts + a plain-English rundown of every
// feature. Triggered from the ? topbar button or ⌘/. Esc / click-outside close it.
// Content is rendered from a single template literal so the help stays in one place.
//
// localStorage key `memry.helpHideOnLaunch` controls auto-open on app start.
// The checkbox in the footer flips it; default is to show on every launch.

const HIDE_ON_LAUNCH_KEY = 'memry.helpHideOnLaunch'

export function shouldShowHelpOnLaunch(): boolean {
  return localStorage.getItem(HIDE_ON_LAUNCH_KEY) !== 'true'
}

const CONTENT_HTML = `
  <h2>Memry</h2>
  <p class="help-lede">A markdown notes app that listens. Record a meeting and it transcribes, cleans up, and summarizes — straight into your note.</p>

  <h3>How a recording works</h3>
  <ol>
    <li>Click the red dot at the top right. Pick an <em>Input</em> — Microphone, System audio, or Recording device. Toggle <em>Show live transcription</em> if you want the ticker.</li>
    <li>Hit <strong>Start</strong>. While recording, a ticker scrolls under your tabs (if enabled) as Groq Whisper transcribes each chunk live.</li>
    <li>Hit <strong>Stop</strong>. The transcript is cleaned up (one <kbd>gpt-4o-mini</kbd> pass to fix misheard words and rejoin fragments), stored alongside its analysis entry, and sent for topic extraction. <strong>It does not get pasted into your note's markdown</strong> — your note stays clean.</li>
    <li>The side panel (<kbd>⌘E</kbd>) lights up with a summary, a Cytoscape topic graph, and a <em>Transcript</em> section holding the source text. <strong>Every recording becomes its own entry</strong> in the history dropdown, so one note can hold many lectures.</li>
  </ol>

  <h3>Tabs</h3>
  <table class="help-keys">
    <tr><td><kbd>⌘N</kbd></td><td>New note in a new tab</td></tr>
    <tr><td><kbd>⌘T</kbd></td><td>Empty new tab (pick <em>New note</em> or <em>Open existing…</em>)</td></tr>
    <tr><td><kbd>⌘⇧T</kbd></td><td>Reopen the last closed tab (LIFO stack, up to 20)</td></tr>
    <tr><td><kbd>⌘W</kbd></td><td>Close the active tab</td></tr>
    <tr><td>Drag tab</td><td>Reorder</td></tr>
    <tr><td>Drag <kbd>⋮⋮</kbd></td><td>From the side panel's Graph section into the tab bar to spawn a graph tab</td></tr>
  </table>

  <h3>Editor</h3>
  <p>Markdown renders in place (Obsidian-style live preview). Put your cursor inside a construct to edit the raw source; move away and it re-renders.</p>
  <ul>
    <li><strong>Format:</strong> <code>**bold**</code>, <code>*italic*</code>, <code>\`code\`</code>, <code># Heading</code>, <code>&gt; quote</code>, <code>- list</code></li>
    <li><strong>Links:</strong> <code>[text](url)</code> and Obsidian <code>[[Wikilinks]]</code> (with <code>[[target|alias]]</code> too)</li>
    <li><strong>Math:</strong> <code>$inline$</code> and <code>$$block$$</code> via KaTeX</li>
    <li><strong>Images:</strong> paste from clipboard or drag from Finder — saved at the vault root, inserted as standard markdown</li>
    <li><strong>Resize images:</strong> hover and drag the blue corner handle, or type <code>|300</code> in the alt text — <code>![alt|300](file.png)</code> (Obsidian's pipe convention; <code>|300x200</code> also works)</li>
  </ul>
  <table class="help-keys">
    <tr><td><kbd>Tab</kbd></td><td>Accept the ghost-text suggestion</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Dismiss the ghost-text suggestion</td></tr>
    <tr><td><kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd></td><td>Undo / redo</td></tr>
  </table>

  <h3>Side panel <kbd>⌘E</kbd></h3>
  <ul>
    <li><strong>History dropdown</strong> — one entry per recording, newest first. Labels are <kbd>DD/MM/YY HH:MM</kbd>; hover to preview the summary.</li>
    <li><kbd>↻</kbd> re-analyzes the active entry on its stored source text — useful after model changes.</li>
    <li><kbd>🗑</kbd> deletes the active entry (and closes any graph tabs that pinned it).</li>
    <li>Each section header has a <kbd>▾</kbd> chevron — click to collapse. State persists.</li>
    <li><strong>Graph section:</strong> <kbd>↗</kbd> opens the graph in its own tab; <kbd>⋮⋮</kbd> drags it out. Click any node to see its supporting quotes from the transcript.</li>
    <li>On a graph tab, click nodes for the same inline detail card — no side panel needed.</li>
    <li><strong>Transcript section</strong> (collapsed by default) — the cleaned-up source text for the active entry. Selectable for copy/paste.</li>
  </ul>

  <h3>Sidebar — folder tree</h3>
  <ul>
    <li>Click a note to open it in the active tab.</li>
    <li><strong>Multi-select:</strong> <kbd>⌘</kbd>-click toggles individual items in/out of the selection; <kbd>⇧</kbd>-click extends the selection through a range. Click any empty area or any unmodified row to clear.</li>
    <li><strong>Bulk actions:</strong> right-click on a selected row → <em>Delete N items</em>. Or drag any selected row to move the whole set into a folder at once.</li>
    <li><strong>Double-click</strong> a note or folder name to rename — <kbd>Enter</kbd> commits, <kbd>Esc</kbd> cancels.</li>
    <li><strong>Drag</strong> notes between folders. Folders can be moved too (can't drop into themselves or their own descendants).</li>
    <li><strong>Right-click</strong> for <em>New note · New folder · Rename · Delete</em>.</li>
    <li><kbd>Quick Notes/</kbd> always exists at the root — that's where overlay captures land.</li>
  </ul>

  <h3>Quick capture <kbd>⌘⇧Space</kbd></h3>
  <p>A frameless floating window for jotting something without leaving what you're doing. Always-on-top, doesn't pull the main app forward.</p>
  <table class="help-keys">
    <tr><td><kbd>⌘↵</kbd></td><td>Save to <kbd>Quick Notes/</kbd>, hide</td></tr>
    <tr><td><kbd>⌘⇧↵</kbd></td><td>Save as a sticky (input clears, window stays)</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Hide everything — overlay + every sticky — without deleting anything</td></tr>
    <tr><td><kbd>+</kbd></td><td>Spawn an empty sticky alongside the overlay</td></tr>
  </table>

  <h3>Stickies</h3>
  <p>Plain-text floating notes (markdown rendered inline, same editor as the main app). Always-on-top, persisted across restarts in <kbd>userData/stickies.json</kbd>.</p>
  <table class="help-keys">
    <tr><td><kbd>⌘↵</kbd></td><td>Close the active sticky</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Hide all stickies + the overlay (text preserved)</td></tr>
    <tr><td><kbd>+</kbd></td><td>Spawn another sticky next to this one</td></tr>
    <tr><td><kbd>×</kbd></td><td>Close this sticky</td></tr>
  </table>

  <h3>Vault</h3>
  <p>Notes live under <kbd>~/Documents/Memry</kbd> by default as plain <kbd>.md</kbd> files — your data is portable and Obsidian-compatible. Each note's analysis history is stored separately in a hidden <kbd>.memry/&lt;noteId&gt;.analysis.json</kbd> sidecar so the markdown stays clean.</p>

  <h3>System shortcuts</h3>
  <table class="help-keys">
    <tr><td><kbd>⌘Q</kbd></td><td>Quit</td></tr>
    <tr><td><kbd>⌘R</kbd></td><td>Reload renderer</td></tr>
    <tr><td><kbd>⌘⇧R</kbd></td><td>Hard reload</td></tr>
    <tr><td><kbd>⌘⌥I</kbd></td><td>Toggle DevTools</td></tr>
    <tr><td><kbd>Ctrl⌘F</kbd></td><td>Fullscreen</td></tr>
    <tr><td><kbd>⌘M</kbd></td><td>Minimize</td></tr>
  </table>

`

const FOOTER_HTML = `
  <label class="help-hide-on-launch">
    <input type="checkbox" data-hide-on-launch />
    <span>Don't show this on launch</span>
  </label>
  <span class="help-footer-hint">Press <kbd>Esc</kbd> or click outside to close.</span>
`

export interface HelpHandle {
  open(): void
  toggle(): void
  close(): void
}

export function mountHelp(): HelpHandle {
  const modal = document.createElement('div')
  modal.className = 'help-modal'
  modal.hidden = true
  modal.innerHTML = `
    <div class="help-backdrop" data-close></div>
    <div class="help-panel" role="dialog" aria-modal="true" aria-label="Memry help">
      <header class="help-header">
        <h1 class="help-title">Help &amp; shortcuts</h1>
        <button class="help-close" data-close type="button" aria-label="Close">×</button>
      </header>
      <div class="help-content">${CONTENT_HTML}</div>
      <footer class="help-footer">${FOOTER_HTML}</footer>
    </div>
  `
  document.body.appendChild(modal)

  const close = (): void => {
    modal.hidden = true
  }
  const open = (): void => {
    modal.hidden = false
    // Reset scroll so the user always sees the lede first on reopen.
    const content = modal.querySelector('.help-content') as HTMLElement | null
    if (content) content.scrollTop = 0
  }
  const toggle = (): void => {
    if (modal.hidden) open()
    else close()
  }

  modal.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('[data-close]')) close()
  })

  const hideOnLaunchEl = modal.querySelector<HTMLInputElement>('[data-hide-on-launch]')
  if (hideOnLaunchEl) {
    hideOnLaunchEl.checked = !shouldShowHelpOnLaunch()
    hideOnLaunchEl.addEventListener('change', () => {
      localStorage.setItem(HIDE_ON_LAUNCH_KEY, String(hideOnLaunchEl.checked))
    })
  }

  // Esc closes — only when the modal is the front-of-mind dismissal target so we
  // don't fight other Esc consumers (popovers, ghost-text) when the modal is hidden.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  return { open, toggle, close }
}
