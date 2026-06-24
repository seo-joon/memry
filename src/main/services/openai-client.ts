// Lazy OpenAI client. We share a single instance across analysis + suggest so the
// SDK's keep-alive socket pool is reused; both services can degrade independently
// (analysis falls back to an empty result, suggest falls back to empty string)
// when OPENAI_API_KEY is missing.
import OpenAI from 'openai'

let client: OpenAI | null = null

export function getOpenAI(): OpenAI | null {
  if (client) return client
  if (!process.env.OPENAI_API_KEY) return null
  client = new OpenAI()
  return client
}
