// Transcription controls live inside a popover anchored under the record button.
// The bottom bar is now JUST the live ticker (one line, animated swap on each
// new chunk) and it only appears while recording + "Show live transcription" is on.
//
// Renderer-only: all privileged work goes through window.api.

import { Recorder, type ListenMode } from './recorder'
import type { SessionId } from '../shared/ipc'

export interface TranscriptionUI {
  destroy(): void
}

const MODES: { value: ListenMode; label: string }[] = [
  { value: 'microphone', label: 'Microphone' },
  { value: 'system', label: 'System audio' },
  { value: 'recording', label: 'Recording device' }
]

const LIVE_PREF_KEY = 'memry.showLiveTranscript'
const MODE_PREF_KEY = 'memry.listenMode'
// Match the .transcript-line exit animation in style.css.
const LINE_EXIT_MS = 280

function loadMode(): ListenMode {
  const saved = localStorage.getItem(MODE_PREF_KEY)
  return saved === 'system' || saved === 'recording' || saved === 'microphone' ? saved : 'microphone'
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function mountTranscriptionUI(opts: {
  popoverEl: HTMLElement
  containerEl: HTMLElement
  transcriptEl: HTMLElement
  toggleEl: HTMLButtonElement
  getNoteId: () => string
  // The note the recording belongs to is pinned at Start and handed back with
  // the result, so switching tabs mid-recording cannot file it elsewhere.
  onTranscriptReady?: (noteId: string, transcript: string) => void
  // Fired the instant the user clicks Stop, BEFORE the cleanup roundtrip. Used
  // to surface immediate "we're working on it" feedback (analysis loading bar)
  // so the user doesn't sit with a dead UI for a few seconds. Carries the same
  // pinned note id as onTranscriptReady.
  onRecordingStopped?: (noteId: string) => void
}): TranscriptionUI {
  const { popoverEl, containerEl, transcriptEl, toggleEl, getNoteId, onTranscriptReady, onRecordingStopped } = opts

  let mode: ListenMode = loadMode()
  let recorder: Recorder | null = null
  let unsub: (() => void) | null = null
  let sessionId: SessionId | null = null
  let recording = false
  let showLive = localStorage.getItem(LIVE_PREF_KEY) !== 'false'
  let currentLine: HTMLElement | null = null
  // The note the active recording belongs to, pinned the moment it starts.
  let startedNoteId = ''
  // Elapsed-time pill next to the record button + input level meter.
  let elapsedIv: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  let meterRaf = 0

  // --- Popover DOM ---
  const startBtn = document.createElement('button')
  startBtn.className = 'record-popover-action'
  startBtn.type = 'button'

  const modeSelect = document.createElement('select')
  modeSelect.className = 'record-popover-mode'
  for (const m of MODES) {
    const opt = document.createElement('option')
    opt.value = m.value
    opt.textContent = m.label
    modeSelect.appendChild(opt)
  }
  modeSelect.value = mode

  const modeRow = document.createElement('label')
  modeRow.className = 'record-popover-row'
  const modeLabel = document.createElement('span')
  modeLabel.textContent = 'Input'
  modeRow.append(modeLabel, modeSelect)

  const liveToggle = document.createElement('input')
  liveToggle.type = 'checkbox'
  liveToggle.checked = showLive
  const liveRow = document.createElement('label')
  liveRow.className = 'record-popover-row record-popover-row-toggle'
  const liveText = document.createElement('span')
  liveText.textContent = 'Show live transcription'
  liveRow.append(liveText, liveToggle)

  const status = document.createElement('div')
  status.className = 'record-popover-status'

  // Input level meter: a thin bar that fills with the live mic level while
  // recording, so a dead device shows up at once instead of after a chunk.
  const meterFill = document.createElement('div')
  meterFill.className = 'record-meter-fill'
  const meter = document.createElement('div')
  meter.className = 'record-meter'
  meter.hidden = true
  meter.appendChild(meterFill)

  const banner = document.createElement('div')
  banner.className = 'record-popover-banner'
  banner.hidden = true

  popoverEl.append(startBtn, modeRow, liveRow, meter, status, banner)

  // Elapsed-time pill beside the record button. The topbar is always visible,
  // so this is the recording indicator on every tab.
  const elapsedEl = document.createElement('span')
  elapsedEl.className = 'record-elapsed'
  elapsedEl.hidden = true
  toggleEl.parentElement?.appendChild(elapsedEl)

  // --- helpers ---
  function setStatus(text: string): void {
    status.textContent = text
  }

  function showBanner(message: string, action?: { label: string; onClick: () => void }): void {
    banner.replaceChildren()
    const msg = document.createElement('span')
    msg.textContent = message
    banner.appendChild(msg)
    if (action) {
      const link = document.createElement('button')
      link.className = 'record-popover-banner-action'
      link.type = 'button'
      link.textContent = action.label
      link.addEventListener('click', action.onClick)
      banner.appendChild(link)
    }
    banner.hidden = false
  }

  function hideBanner(): void {
    banner.hidden = true
    banner.replaceChildren()
  }

  function reflectRecording(): void {
    recording = recorder !== null
    toggleEl.classList.toggle('is-recording', recording)
    startBtn.textContent = recording ? 'Stop recording' : 'Start recording'
    startBtn.classList.toggle('is-recording', recording)
    modeSelect.disabled = recording
    meter.hidden = !recording
    if (!recording) {
      meterFill.style.width = '0%'
      elapsedEl.hidden = true
    }
    // Ticker bar lives only while we're actively recording AND user wants it.
    const shouldShow = recording && showLive
    containerEl.hidden = !shouldShow
    if (!shouldShow) clearLine()
  }

  function startElapsed(): void {
    startedAt = Date.now()
    elapsedEl.textContent = '0:00'
    elapsedEl.hidden = false
    if (elapsedIv) clearInterval(elapsedIv)
    elapsedIv = setInterval(() => {
      elapsedEl.textContent = formatElapsed(Date.now() - startedAt)
    }, 1000)
  }

  function stopElapsed(): void {
    if (elapsedIv) {
      clearInterval(elapsedIv)
      elapsedIv = null
    }
    elapsedEl.hidden = true
  }

  function startMeter(): void {
    cancelAnimationFrame(meterRaf)
    const tick = (): void => {
      if (!recorder) return
      meterFill.style.width = `${Math.round(Math.min(1, recorder.level()) * 100)}%`
      meterRaf = requestAnimationFrame(tick)
    }
    meterRaf = requestAnimationFrame(tick)
  }

  function stopMeter(): void {
    cancelAnimationFrame(meterRaf)
    meterRaf = 0
    meterFill.style.width = '0%'
  }

  // --- popover open/close ---
  function openPopover(): void {
    popoverEl.hidden = false
  }
  function closePopover(): void {
    popoverEl.hidden = true
  }
  function togglePopover(): void {
    if (popoverEl.hidden) openPopover()
    else closePopover()
  }

  // Click outside the popover (and not on the trigger) → close. Esc → close.
  const onDocClick = (e: MouseEvent): void => {
    if (popoverEl.hidden) return
    const target = e.target as Node
    if (popoverEl.contains(target) || toggleEl.contains(target)) return
    closePopover()
  }
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !popoverEl.hidden) closePopover()
  }
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onDocKey)

  // --- permission gating ---
  // For 'system' we used to pre-check systemPreferences.getMediaAccessStatus('screen'),
  // but on Sequoia that API returns 'denied' for unsigned dev Electron even when
  // the toggle is on. We now just try the capture; recorder.ts surfaces a
  // permission-shaped error message if macOS actually refuses.
  async function ensurePermission(): Promise<boolean> {
    hideBanner()
    if (mode === 'microphone') {
      const ok = await window.api.audio.ensureMic()
      if (!ok) {
        showBanner('Microphone access is not allowed. Enable it in System Settings > Privacy & Security > Microphone.')
        return false
      }
    }
    return true
  }

  async function start(): Promise<void> {
    if (recording) return
    const noteId = getNoteId()
    if (!noteId) {
      setStatus('Open a note first, then record into it.')
      return
    }
    setStatus('Preparing…')
    if (!(await ensurePermission())) {
      setStatus('')
      return
    }
    try {
      startedNoteId = noteId
      sessionId = await window.api.transcription.start(noteId)
      const sid = sessionId
      unsub = window.api.transcription.onAppend((p) => {
        if (p.sessionId === sid && p.delta) showLine(p.delta)
      })
      recorder = new Recorder(mode, (buf, mime) =>
        window.api.transcription.pushChunk(sid, buf, mime)
      )
      reflectRecording()
      await recorder.start()
      setStatus('Listening…')
      startElapsed()
      startMeter()
      // Leave the popover open so the user can see recording started; they can
      // dismiss it themselves (click-outside or Esc).
    } catch (err) {
      await cleanupSession()
      setStatus('')
      // Surface a Settings shortcut whenever the failure looks permission-shaped
      // — covers the Sequoia case where the toggle is on but capture still fails.
      const msg = err instanceof Error ? err.message : 'Could not start transcription.'
      const isScreenPerm = mode === 'system' && /screen recording|loopback|system audio|permission|notallowed/i.test(msg)
      showBanner(msg, isScreenPerm ? { label: 'Open Settings', onClick: () => window.api.audio.openScreenSettings() } : undefined)
    }
  }

  async function stop(): Promise<void> {
    if (!recording || !sessionId) return
    const sid = sessionId
    const noteId = startedNoteId
    // Fire BEFORE any await so the renderer can paint loading feedback in the
    // same frame as the click. The cleanup call below takes a few seconds.
    onRecordingStopped?.(noteId)
    setStatus('Finishing…')
    recorder?.stop()
    recorder = null
    stopMeter()
    stopElapsed()
    reflectRecording()
    let final = ''
    try {
      final = await window.api.transcription.stop(sid)
    } finally {
      unsub?.()
      unsub = null
      sessionId = null
      startedNoteId = ''
      setStatus('')
    }
    onTranscriptReady?.(noteId, final)
  }

  async function cleanupSession(): Promise<void> {
    recorder?.stop()
    recorder = null
    stopMeter()
    stopElapsed()
    unsub?.()
    unsub = null
    if (sessionId) {
      try {
        await window.api.transcription.stop(sessionId)
      } catch {
        /* best-effort */
      }
      sessionId = null
    }
    reflectRecording()
  }

  // --- live ticker ---
  function clearLine(): void {
    transcriptEl.replaceChildren()
    currentLine = null
  }

  function showLine(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (currentLine) {
      const old = currentLine
      old.classList.add('exit')
      setTimeout(() => old.remove(), LINE_EXIT_MS)
    }
    const line = document.createElement('div')
    line.className = 'transcript-line'
    line.textContent = trimmed
    transcriptEl.appendChild(line)
    currentLine = line
  }

  // --- events ---
  toggleEl.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePopover()
  })

  startBtn.addEventListener('click', () => {
    void (recording ? stop() : start())
  })

  modeSelect.addEventListener('change', () => {
    mode = modeSelect.value as ListenMode
    localStorage.setItem(MODE_PREF_KEY, mode)
    hideBanner()
  })

  liveToggle.addEventListener('change', () => {
    showLive = liveToggle.checked
    localStorage.setItem(LIVE_PREF_KEY, String(showLive))
    reflectRecording()
  })

  reflectRecording()

  return {
    destroy() {
      recorder?.stop()
      recorder = null
      stopMeter()
      stopElapsed()
      unsub?.()
      unsub = null
      sessionId = null
      elapsedEl.remove()
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onDocKey)
      popoverEl.replaceChildren()
    }
  }
}
