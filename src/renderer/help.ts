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
  <p class="help-lede">A notes app that listens. Record a meeting or a lecture and Memry writes down what was said, tidies it up, and summarises it for you.</p>

  <h3>Recording</h3>
  <ol>
    <li>Click the red dot at the top right.</li>
    <li>Choose what to listen to. Pick Microphone for people in the room with you, System audio for calls and videos playing on your Mac, or Recording device if you have separate audio equipment.</li>
    <li>Turn on Show live transcription if you want to watch the words appear as you go.</li>
    <li>Press Start.</li>
    <li>Press Stop when you are done. Memry fixes misheard words, joins up broken sentences, and works out the main topics.</li>
  </ol>
  <p>Your note stays exactly as you wrote it. The written record and the summary appear in the side panel.</p>
  <p>Each recording is kept on its own, so one note can hold a whole term of lectures. Use the list at the top of the side panel to move between them.</p>

  <h3>Tabs</h3>
  <table class="help-keys">
    <tr><td><kbd>⌘N</kbd></td><td>New note in a new tab</td></tr>
    <tr><td><kbd>⌘T</kbd></td><td>New empty tab</td></tr>
    <tr><td><kbd>⌘⇧T</kbd></td><td>Bring back a tab you closed. Press again for earlier ones</td></tr>
    <tr><td><kbd>⌘W</kbd></td><td>Close this tab</td></tr>
    <tr><td><kbd>⌘O</kbd></td><td>Find a note and open it</td></tr>
  </table>
  <p>Drag a tab sideways to change its order.</p>
  <p>Every shortcut on this page can be switched off in Settings.</p>

  <h3>Writing</h3>
  <p>Formatting shows as you type. Click inside formatted text to see the plain version, then click away and it changes back.</p>
  <ul>
    <li><strong>Bold and italic:</strong> <code>**bold**</code> and <code>*italic*</code></li>
    <li><strong>Headings:</strong> start the line with <code>#</code></li>
    <li><strong>Lists:</strong> start the line with <code>-</code></li>
    <li><strong>Quotes:</strong> start the line with <code>&gt;</code></li>
    <li><strong>Links:</strong> <code>[what to show](the address)</code></li>
    <li><strong>Links to your other notes:</strong> <code>[[Note name]]</code>, or <code>[[Note name|what to show]]</code></li>
    <li><strong>Maths:</strong> <code>$x^2$</code> in the middle of a sentence, or <code>$$x^2$$</code> on its own line</li>
    <li><strong>Pictures:</strong> paste one in, or drag one in from a folder</li>
    <li><strong>Picture size:</strong> point at a picture and drag the blue corner, or set the width like this: <code>![picture|300](photo.png)</code></li>
  </ul>
  <table class="help-keys">
    <tr><td><kbd>⌘B</kbd></td><td>Bold</td></tr>
    <tr><td><kbd>⌘I</kbd></td><td>Italic</td></tr>
    <tr><td><kbd>⌘K</kbd></td><td>Link</td></tr>
    <tr><td><kbd>⌘⇧C</kbd></td><td>Inline code</td></tr>
    <tr><td><kbd>⌘⇧S</kbd></td><td>Strikethrough</td></tr>
    <tr><td><kbd>Tab</kbd></td><td>Accept the grey suggestion</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Dismiss the grey suggestion</td></tr>
    <tr><td><kbd>⌘Z</kbd></td><td>Undo</td></tr>
    <tr><td><kbd>⌘⇧Z</kbd></td><td>Redo</td></tr>
    <tr><td><kbd>⌘/</kbd></td><td>Open this help</td></tr>
  </table>

  <h3>Side panel</h3>
  <table class="help-keys">
    <tr><td><kbd>⌘E</kbd></td><td>Show or hide the side panel</td></tr>
  </table>
  <ul>
    <li>The list at the top shows your recordings, newest first. Point at one to see what it covers.</li>
    <li><strong>Summary</strong> gives the main points in a few sentences.</li>
    <li><strong>Writing about</strong> suggests topics that fit the paragraph your cursor is in.</li>
    <li><strong>Graph</strong> draws the topics as a map. Click a topic to see the exact words behind it. The arrow button opens the map in its own tab.</li>
    <li><strong>Transcript</strong> holds the full written record. It starts folded away.</li>
    <li>Click the small arrow on any heading to fold that part away. Memry remembers your choice.</li>
    <li>The refresh button builds the summary again from the same recording.</li>
    <li>The bin button removes the recording you are looking at.</li>
  </ul>

  <h3>Notes list</h3>
  <ul>
    <li>Click a note to open it.</li>
    <li><strong>Pick several at once:</strong> hold <kbd>⌘</kbd> and click to add notes one by one, or hold <kbd>⇧</kbd> and click to take everything in between. Click an empty spot to start over.</li>
    <li><strong>Rename:</strong> double click the name. Press <kbd>↵</kbd> to keep the new name, or <kbd>Esc</kbd> to cancel.</li>
    <li><strong>Move:</strong> drag notes into folders. You can drag whole folders too.</li>
    <li><strong>Right click</strong> for new note, new folder, rename, and delete. Right click a group you picked to remove them together.</li>
  </ul>

  <h3>Sticky notes</h3>
  <p>Small notes that float above your other apps, for jotting something down in the moment. They stay where you put them and are still there when you reopen Memry.</p>
  <table class="help-keys">
    <tr><td><kbd>⌘⇧Space</kbd></td><td>Show or hide sticky notes. Works wherever you are</td></tr>
    <tr><td><kbd>⌘↵</kbd></td><td>Save what you typed as a note, then close</td></tr>
    <tr><td><kbd>⌘↵ in a sticky note</kbd></td><td>Close that sticky note</td></tr>
    <tr><td><kbd>⌘⇧↵</kbd></td><td>Turn what you typed into a sticky note and keep typing</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Hide everything. Nothing is removed</td></tr>
  </table>
  <p>The + button adds another sticky note. The cross button closes that sticky note.</p>
  <p>Sticky notes cannot open while Memry fills the screen. Press <kbd>Ctrl⌘F</kbd> to leave full screen first.</p>
  <p>Notes you save with <kbd>⌘↵</kbd> go into a folder called Quick Notes.</p>

  <h3>Where your notes live</h3>
  <p>In <kbd>Documents/Memry</kbd>, as ordinary text files. Copy them or open them in another app whenever you like.</p>

  <h3>Memry app</h3>
  <table class="help-keys">
    <tr><td><kbd>⌘Q</kbd></td><td>Quit</td></tr>
    <tr><td><kbd>⌘M</kbd></td><td>Minimise</td></tr>
    <tr><td><kbd>⌘H</kbd></td><td>Hide Memry</td></tr>
    <tr><td><kbd>⌘R</kbd></td><td>Reload if something looks stuck</td></tr>
    <tr><td><kbd>Ctrl⌘F</kbd></td><td>Fill the screen</td></tr>
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
  markSeen(): void
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
  // First-launch onboarding calls this right after auto-opening, so later
  // launches stay quiet. Also ticks the checkbox to match.
  const markSeen = (): void => {
    localStorage.setItem(HIDE_ON_LAUNCH_KEY, 'true')
    if (hideOnLaunchEl) hideOnLaunchEl.checked = true
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

  // Esc closes, but only when the modal is open, so it never fights other Esc
  // uses (popovers, ghost text) while hidden.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  return { open, toggle, close, markSeen }
}
