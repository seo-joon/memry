// Inline ghost-text completions. Cheap model (gpt-4.1-nano), fed the analysis
// result for the active note as context — most of the work is just "reword the
// already-extracted topic" so a small model is enough.
//
// Returns '' on any failure / missing key / no useful continuation so the editor
// never shows broken ghost text.
import type { AnalysisResult } from '../../shared/ipc'
import { readLatestResult } from './analysis'
import { getOpenAI } from './openai-client'

const MODEL = 'gpt-4.1-nano'
const TIMEOUT_MS = 4_000
// Average per-token probability below which we suppress the ghost text. The model
// runs at temperature 0.3 — high-confidence continuations cluster near ~0.85+;
// low-confidence ones (random guesses with little context) sit closer to 0.4.
// 0.60 filters out most "just typing for the sake of it" suggestions while still
// letting through obvious completions ("the system arch..." → "itecture").
const CONFIDENCE_THRESHOLD = 0.6

const SYSTEM_PROMPT = `You are an inline writing assistant for a notes app. The user is mid-sentence; continue what they just wrote.

Hard rules:
- Output ONLY the continuation text — no preamble, no quotes, no explanation, no markdown.
- Do NOT repeat what they already wrote. Pick up from where they stopped.
- Maximum 15 words.
- If their text already ends mid-word, complete the word naturally; if it ends after a space, start the next word.
- Reuse facts and phrasings from the CONTEXT when they fit. Never invent facts not present in the context.
- If you cannot produce a useful continuation, return an empty string.`

function buildContext(analysis: AnalysisResult | null): string {
  if (!analysis || (!analysis.summary && !analysis.nodes.length)) return '(no meeting context yet)'
  const lines: string[] = []
  if (analysis.summary) lines.push(`SUMMARY: ${analysis.summary}`)
  if (analysis.nodes.length) {
    lines.push('TOPICS:')
    for (const n of analysis.nodes) lines.push(`- ${n.title}: ${n.description}`)
  }
  return lines.join('\n')
}

export async function suggest(noteId: string, paragraph: string): Promise<string> {
  const text = paragraph.trim()
  if (!text) return ''
  const openai = getOpenAI()
  if (!openai) return ''

  const analysis = await readLatestResult(noteId)
  const context = buildContext(analysis)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `CONTEXT:\n${context}\n\nUSER IS WRITING:\n${paragraph}` }
        ],
        max_tokens: 40,
        temperature: 0.3,
        // Ask the API for per-token log-probs so we can gate on confidence. Tokens
        // are decoded one at a time; a low average probability means the model was
        // guessing — surfacing that as ghost text would interrupt the user's flow.
        logprobs: true
      },
      { signal: controller.signal }
    )
    const out = (response.choices[0]?.message?.content ?? '').trim()
    if (!out) return ''

    const tokens = response.choices[0]?.logprobs?.content ?? []
    if (tokens.length) {
      const avgProb = tokens.reduce((s, t) => s + Math.exp(t.logprob), 0) / tokens.length
      if (avgProb < CONFIDENCE_THRESHOLD) {
        console.log('[suggest] rejected (avgProb=%s) "%s"', avgProb.toFixed(3), out)
        return ''
      }
    }
    return out
  } catch (err) {
    if ((err as Error).name !== 'AbortError') console.error('[suggest] failed:', err)
    return ''
  } finally {
    clearTimeout(timer)
  }
}
