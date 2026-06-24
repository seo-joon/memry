// The ONE wikilink pattern, shared by the live-preview renderer and the future graph.
// Matches [[target]] and [[target|alias]]; single-line (no \n) so a rendered wikilink
// never spans a line break; global so matchAll / exec can iterate.
export const WIKILINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g

export interface WikiLink {
  target: string
  alias?: string
}

// Stateless extraction (does not rely on the regex's lastIndex).
export function extractWikiLinks(src: string): WikiLink[] {
  const links: WikiLink[] = []
  for (const m of src.matchAll(WIKILINK_RE)) {
    links.push({ target: m[1].trim(), alias: m[2]?.trim() })
  }
  return links
}
