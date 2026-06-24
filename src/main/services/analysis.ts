// Per-recording analysis: each transcript becomes one AnalysisEntry. The sidecar
// stores the full history as an array so multiple meetings/lectures inside the
// same note keep their own summary + topic graph. Legacy single-object sidecars
// are migrated on first read.
import { promises as fs, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AnalysisEntry, AnalysisResult } from '../../shared/ipc'
import { getVaultPath } from '../vault'
import { getOpenAI } from './openai-client'

const MODEL = 'gpt-4o-mini'
const SIDECAR_DIR = '.memry'
const LABEL_MAX = 60

const SYSTEM_PROMPT = `You analyze a meeting or lecture transcript and extract a knowledge graph.

Rules:
- Identify the core topics discussed (concepts, entities, ideas, decisions). Aim for 5-15 nodes — fewer for short transcripts, more for dense ones.
- For each topic, write a 1-2 sentence description grounded ONLY in what was said.
- Include 1-3 short verbatim quotes from the transcript that justify the topic. Trim quotes to the meaningful span (no filler).
- Identify meaningful connections between topics. Each edge gets a short natural-language label (4-8 words) explaining the relationship.
- Produce an overall summary in 3-5 sentences.
- "id" is a lowercase kebab-case slug derived from the title (e.g. "Aesop's Fables" -> "aesops-fables"). Use the same id when referencing nodes in edges.from / edges.to.

Return JSON matching the provided schema. Do not invent facts not present in the transcript.`

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'title', 'description', 'sources'],
        additionalProperties: false
      }
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' }
        },
        required: ['from', 'to', 'label'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'nodes', 'edges'],
  additionalProperties: false
} as const

const EMPTY: AnalysisResult = { summary: '', nodes: [], edges: [] }

function sidecarPath(noteId: string): string {
  const safe = encodeURIComponent(noteId)
  return join(getVaultPath(), SIDECAR_DIR, `${safe}.analysis.json`)
}

function makeLabel(result: AnalysisResult): string {
  const s = result.summary?.trim()
  if (s) return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1).trimEnd() + '…' : s
  const firstNode = result.nodes[0]?.title?.trim()
  return firstNode || 'Analysis'
}

// Pre-array sidecars stored a bare AnalysisResult. Wrap them so older notes
// don't lose their existing analysis on upgrade. sourceText is unknown for
// legacy entries — the renderer disables re-analyze when it's empty.
function migrateLegacy(raw: unknown): AnalysisEntry[] {
  if (Array.isArray(raw)) return raw as AnalysisEntry[]
  if (raw && typeof raw === 'object' && 'summary' in raw && 'nodes' in raw) {
    const result = raw as AnalysisResult
    return [
      {
        id: randomUUID(),
        createdAt: Date.now(),
        label: makeLabel(result),
        sourceText: '',
        result
      }
    ]
  }
  return []
}

export async function readEntries(noteId: string): Promise<AnalysisEntry[]> {
  const p = sidecarPath(noteId)
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(await fs.readFile(p, 'utf8'))
    if (Array.isArray(raw)) return raw as AnalysisEntry[]
    // Legacy single-object sidecar. migrateLegacy() generates a fresh randomUUID
    // every call — so without persisting the result, every subsequent read would
    // hand the renderer a different entry id for the same content, and any
    // round-tripped id (e.g. graph-popout's entry.id) would fail to match on the
    // next read. Persist the migrated array back to disk so this only happens once.
    const migrated = migrateLegacy(raw)
    if (migrated.length) await writeEntries(noteId, migrated)
    return migrated
  } catch (err) {
    console.error('[analysis] failed to read sidecar:', err)
    return []
  }
}

// Used by the suggest service — only needs the latest entry's content.
export async function readLatestResult(noteId: string): Promise<AnalysisResult | null> {
  const entries = await readEntries(noteId)
  return entries.length ? entries[entries.length - 1].result : null
}

async function writeEntries(noteId: string, entries: AnalysisEntry[]): Promise<void> {
  const p = sidecarPath(noteId)
  await fs.mkdir(dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(entries, null, 2), 'utf8')
}

async function callOpenAI(transcript: string): Promise<AnalysisResult> {
  const openai = getOpenAI()
  if (!openai) {
    console.warn('[analysis] no OpenAI client (OPENAI_API_KEY missing?)')
    return EMPTY
  }
  console.log('[analysis] calling OpenAI', { model: MODEL, transcriptLen: transcript.length })
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'AnalysisResult', schema: SCHEMA, strict: true }
      }
    })
    const raw = response.choices[0]?.message?.content
    if (!raw) {
      console.warn('[analysis] empty content from OpenAI')
      return EMPTY
    }
    const parsed = JSON.parse(raw) as AnalysisResult
    console.log('[analysis] success', { summaryLen: parsed.summary?.length ?? 0, nodes: parsed.nodes?.length ?? 0 })
    return parsed
  } catch (err) {
    console.error('[analysis] failed:', err)
    return EMPTY
  }
}

function emptyEntry(sourceText: string): AnalysisEntry {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    label: 'Analysis',
    sourceText,
    result: EMPTY
  }
}

// Append a fresh analysis for a newly-finished transcript.
export async function runAnalysis(noteId: string, transcript: string): Promise<AnalysisEntry> {
  const trimmed = transcript.trim()
  if (!trimmed) return emptyEntry('')
  const result = await callOpenAI(trimmed)
  const entry: AnalysisEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    label: makeLabel(result),
    sourceText: trimmed,
    result
  }
  const entries = await readEntries(noteId)
  entries.push(entry)
  await writeEntries(noteId, entries)
  return entry
}

// Re-run an existing entry — same source text, fresh model call, in-place
// update. The entry id and createdAt are preserved so the user's selection in
// the history dropdown survives the re-run.
export async function replaceEntry(
  noteId: string,
  entryId: string,
  transcript: string
): Promise<AnalysisEntry> {
  const trimmed = transcript.trim()
  const entries = await readEntries(noteId)
  const idx = entries.findIndex((e) => e.id === entryId)
  if (idx === -1) {
    // Entry vanished — fall back to append so the user still gets a result.
    return runAnalysis(noteId, trimmed)
  }
  if (!trimmed) return entries[idx]
  const result = await callOpenAI(trimmed)
  const updated: AnalysisEntry = {
    ...entries[idx],
    label: makeLabel(result),
    sourceText: trimmed,
    result
  }
  entries[idx] = updated
  await writeEntries(noteId, entries)
  return updated
}

export async function deleteEntry(noteId: string, entryId: string): Promise<void> {
  const entries = await readEntries(noteId)
  const next = entries.filter((e) => e.id !== entryId)
  if (next.length === entries.length) return
  await writeEntries(noteId, next)
}
