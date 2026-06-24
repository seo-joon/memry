import { randomUUID } from 'node:crypto'
import type { SessionId } from '../../shared/ipc'

// Per-session transcript accumulator with a soft 2h cap (single-user app — the
// cap is the only AI-cost guardrail). Crossing the cap appends a one-time notice
// then silently drops further chunks for that session.
const MEETING_CAP_MS = 2 * 60 * 60 * 1000
const CAP_NOTICE = '[meeting cap reached — transcription paused]'

interface Session {
  text: string
  startedAt: number
  capped: boolean
}

const sessions = new Map<SessionId, Session>()

export function startSession(): SessionId {
  const id = randomUUID()
  sessions.set(id, { text: '', startedAt: Date.now(), capped: false })
  return id
}

// Returns the text actually appended ('' when nothing was added).
export function appendChunk(id: SessionId, text: string): string {
  const session = sessions.get(id)
  if (!session) return ''

  if (Date.now() - session.startedAt > MEETING_CAP_MS) {
    if (session.capped) return ''
    // First time past the cap: emit the notice once, then go quiet.
    session.capped = true
    session.text = session.text ? `${session.text} ${CAP_NOTICE}` : CAP_NOTICE
    return CAP_NOTICE
  }

  const delta = text.trim()
  if (!delta) return ''
  session.text = session.text ? `${session.text} ${delta}` : delta
  return delta
}

export function getTranscript(id: SessionId): string {
  return sessions.get(id)?.text ?? ''
}

// Returns the final transcript and frees the session.
export function endSession(id: SessionId): string {
  const text = sessions.get(id)?.text ?? ''
  sessions.delete(id)
  return text
}
