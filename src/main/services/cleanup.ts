// Post-pass cleanup of a raw whisper transcript via gpt-4o-mini.
// Whisper output is fragmented and full of recognition errors at our 4s chunks
// (misheard words, [BLANK_AUDIO] markers, mid-sentence breaks split across
// chunk boundaries — e.g. "anthropomorphic" -> "anthro homomorphic" when the
// word straddles two clips). One LLM pass at end-of-recording reconstructs it.
//
// Never throws: if OPENAI_API_KEY is missing, the SDK errors, or the model
// refuses, we return the raw text unchanged so the user always gets *something*
// in their note.
import { getOpenAI } from './openai-client'

const MODEL = 'gpt-4o-mini'

const SYSTEM_PROMPT = `You clean up raw speech-to-text transcripts.

The input is whisper output from short 4-second audio chunks. It contains:
- Misheard words you can fix from surrounding context (e.g. "Trent parent" -> "transparent", "A sub Fables" -> "Aesop's Fables", "for PCE" -> "BCE", "glyphic to face" -> "Glyph Interface", "anthro homomorphic" -> "anthropomorphic").
- Words split across chunk boundaries that whisper guessed at the second half of (e.g. a word starting in chunk N and finishing as a different word in chunk N+1). Rejoin them.
- Non-speech tags like [BLANK_AUDIO], (music), (dramatic music), (silence) — strip them entirely.
- Fragments from chunk boundaries with awkward sentence breaks and stray periods.

Your job:
- Fix obvious recognition errors that context makes clear. If a fix is uncertain, leave the original word.
- Strip every non-speech marker.
- Join fragments into coherent sentences and paragraphs using natural punctuation.
- Preserve the speaker's meaning and voice — do not paraphrase, summarize, add, or remove content.
- Output ONLY the cleaned transcript text — no preamble, no explanation, no quotation marks, no markdown fences.`

export async function cleanup(rawText: string): Promise<string> {
  const openai = getOpenAI()
  if (!openai) return rawText
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: rawText }
      ]
    })
    return response.choices[0]?.message?.content?.trim() || rawText
  } catch (err) {
    console.error('[cleanup] failed:', err)
    return rawText
  }
}
