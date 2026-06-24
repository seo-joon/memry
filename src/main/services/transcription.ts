// Groq-hosted Whisper Large v3 Turbo (MAIN only — holds GROQ_API_KEY). Groq exposes
// an OpenAI-compatible audio transcription endpoint at ~164–216x realtime, $0.04/hr.
// Each chunk from the renderer is a self-contained WebM blob the endpoint decodes
// directly — no local ffmpeg, no whisper-cli binary, no model download.
//
// Never throws: missing key / non-2xx / timeout / network error all degrade to STUB
// so the recording pipeline keeps moving and the user sees a readable placeholder.
const STUB = '[transcription unavailable — set GROQ_API_KEY]'
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'
// Turbo: distilled 4-decoder-layer variant. ~0.4 WER pts behind full v3 on average,
// near-tied on clean English, and wins on cost ($0.04/hr vs $0.111/hr). Right pick
// for meetings where chunked latency matters more than the last fraction of a WER pt.
const MODEL = 'whisper-large-v3-turbo'
const TIMEOUT_MS = 30_000

export async function transcribe(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return STUB

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const form = new FormData()
    // Each chunk is a self-contained webm; name it so Groq sniffs the format.
    form.append('file', new Blob([buffer], { type: mimeType }), 'chunk.webm')
    form.append('model', MODEL)
    form.append('response_format', 'text')
    // language=en explicitly: Groq's docs note it improves accuracy AND latency by
    // skipping the language-detection pass (which itself misfires on short/silent clips).
    form.append('language', 'en')

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      // Authorization only — let undici set the multipart boundary on Content-Type.
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
    if (!res.ok) {
      console.error(`[transcription] HTTP ${res.status}: ${await res.text()}`)
      return STUB
    }
    // response_format 'text' => raw transcript body.
    return (await res.text()).trim()
  } catch (err) {
    console.error('[transcription] failed:', err)
    return STUB
  } finally {
    clearTimeout(timer)
  }
}
