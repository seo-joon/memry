// Audio capture for transcription. Renderer-only: no Node/electron imports.
//
// CHUNKING STRATEGY (the single biggest correctness pitfall — see BLUEPRINT §5.4):
// We do NOT use MediaRecorder timeslice. Timeslice fragments after the first are
// headerless WebM and Whisper rejects them. Instead we stop/restart the recorder
// every `chunkMs`, so each `ondataavailable` blob is a complete, self-contained
// WebM file Whisper can decode on its own.
//
// SYSTEM AUDIO: we do NOT import electron-audio-loopback here — its renderer helper
// pulls Node/main code into the browser bundle (crashes on __dirname). Instead we
// replicate its tiny manual flow over window.api (see preload + main loopback-setup).

export type ListenMode = 'microphone' | 'system' | 'recording'

const DEFAULT_CHUNK_MS = 12_000
const MIME = 'audio/webm;codecs=opus'

export class Recorder {
  readonly mode: ListenMode
  private readonly onChunk: (audio: ArrayBuffer, mimeType: string) => void
  private readonly chunkMs: number

  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private cycleTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null

  constructor(
    mode: ListenMode,
    onChunk: (audio: ArrayBuffer, mimeType: string) => void,
    opts?: { chunkMs?: number }
  ) {
    this.mode = mode
    this.onChunk = onChunk
    this.chunkMs = opts?.chunkMs ?? DEFAULT_CHUNK_MS
  }

  async start(): Promise<void> {
    if (this.running) return
    this.stream = await this.acquireStream()
    this.running = true
    this.setupMeter()
    this.beginCycle()
  }

  // Current input loudness, 0 (silent) to ~1 (loud). Used for the level meter.
  // Returns 0 when metering is unavailable. Never throws.
  level(): number {
    if (!this.analyser) return 0
    try {
      const data = new Uint8Array(this.analyser.fftSize)
      this.analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      // Speech at normal volume lands around 0.05 RMS, so boost it onto a
      // readable scale. The caller clamps to 1.
      return Math.sqrt(sum / data.length) * 6
    } catch {
      return 0
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer)
      this.cycleTimer = null
    }
    // Flushes the final blob via onstop; onstop sees running=false and won't restart.
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop()
    }
    this.recorder = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.analyser = null
    if (this.audioCtx) {
      const ctx = this.audioCtx
      this.audioCtx = null
      void ctx.close().catch(() => undefined)
    }
  }

  // Passive loudness tap for the level meter. A failure here must never break
  // recording, so everything is guarded and level() degrades to 0.
  private setupMeter(): void {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx || !this.stream) return
      this.audioCtx = new Ctx()
      const src = this.audioCtx.createMediaStreamSource(this.stream)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 256
      src.connect(this.analyser)
    } catch {
      this.analyser = null
    }
  }

  // One self-contained recording cycle: a fresh MediaRecorder produces exactly one
  // complete WebM blob, then we restart for the next chunk while still running.
  private beginCycle(): void {
    if (!this.running || !this.stream) return

    const rec = new MediaRecorder(this.stream, { mimeType: MIME })
    this.recorder = rec

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        e.data.arrayBuffer().then((buf) => this.onChunk(buf, e.data.type || MIME))
      }
    }
    rec.onstop = () => {
      if (this.running) this.beginCycle()
    }

    rec.start()
    this.cycleTimer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
    }, this.chunkMs)
  }

  private async acquireStream(): Promise<MediaStream> {
    try {
      if (this.mode === 'system') {
        // Manual loopback dance (contextIsolation-safe): main installs a display-media
        // handler while loopback is enabled, so getDisplayMedia returns system audio.
        // getDisplayMedia requires video:true; we discard the video track afterward.
        await window.api.audio.enableLoopback()
        let stream: MediaStream
        try {
          // Race with an 8s timeout: on Sequoia, when Screen Recording permission
          // is stale (toggle on, TCC cache says no), the loopback main handler
          // rejects internally but getDisplayMedia just hangs. Without the race
          // the UI sits on "Preparing…" forever.
          stream = await Promise.race([
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
            new Promise<MediaStream>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      'System audio capture timed out. The Screen Recording entry is stale: quit Memry, turn Memry off and back on in System Settings, then reopen Memry. (When running from code, toggle Electron instead.)'
                    )
                  ),
                8_000
              )
            )
          ])
        } finally {
          await window.api.audio.disableLoopback()
        }
        stream.getVideoTracks().forEach((t) => {
          t.stop()
          stream.removeTrack(t)
        })
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((t) => t.stop())
          throw new Error(
            'No system audio captured. Grant Screen Recording and relaunch Memry, or use a loopback device like BlackHole.'
          )
        }
        return stream
      }
      // microphone / recording: a normal input device (BlackHole, if installed,
      // shows up here as an ordinary input — no extra code needed).
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, channelCount: 1 },
        video: false
      })
    } catch (err) {
      throw new Error(audioErrorMessage(this.mode, err))
    }
  }
}

function audioErrorMessage(mode: ListenMode, err: unknown): string {
  // Preserve our own already-friendly messages (e.g. the no-audio-track case).
  if (err instanceof Error && /system audio|loopback|screen recording/i.test(err.message)) {
    return err.message
  }
  if (mode === 'system') {
    return 'Could not capture system audio. Grant Screen Recording in System Settings and relaunch Memry, or use a loopback device like BlackHole.'
  }
  return 'Could not access the microphone. Check that mic access is allowed in System Settings.'
}
