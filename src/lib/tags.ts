// Tag parsing + FTS5 query helpers for saved circuits.
// ─────────────────────────────────────────────────────────────────────────────
// Tags are stored in TWO places (kept in sync on every write):
//   1. `saved_circuits.tags`  — TEXT column with the canonical comma-separated
//      string (human-readable, backward compatible, source of truth).
//   2. `circuit_tags`         — normalized rows (one per tag, lowercased) used
//      for exact-match filtering.
//   3. `circuits_fts`         — FTS5 index over name/description/tags.
//
// Case policy (documented decision):
//   - `parseTags()` PRESERVES the case of the first occurrence of each tag —
//     that's what we display (chips, `tagList` API field, TEXT column).
//   - `normalizeTag()` lowercases for storage in `circuit_tags` and for query
//     comparison, so matching is case-insensitive without relying on collations.
//   - FTS5's default unicode61 tokenizer is ASCII-case-insensitive, so search
//     behaves the same way.
//
// Separator policy: tags are delimited by commas and/or whitespace — a tag is
// a single word ("power supply" means two tags: "power", "supply").

/** Split a raw tags string into individual tags (commas and/or whitespace). */
const TAG_SEPARATOR = /[\s,]+/;

/**
 * Parse a raw tags string into a list of tags.
 *
 * - splits on commas and/or whitespace
 * - trims each tag and drops empties
 * - deduplicates case-insensitively, keeping the FIRST spelling seen
 *   (display case is preserved)
 */
export function parseTags(raw: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(TAG_SEPARATOR)) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Normalize a single tag for storage/query: trimmed + lowercased so that
 * `circuit_tags` matching is exact AND case-insensitive.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Canonicalize a raw tags string into the TEXT form stored in
 * `saved_circuits.tags`: `parseTags(raw).join(', ')`.
 *
 * Guarantees `parseTags(canonicalizeTags(x))` round-trips to the same list,
 * so the TEXT column and the `circuit_tags` rows can never disagree.
 */
export function canonicalizeTags(raw: string): string {
  return parseTags(raw).join(', ');
}

/**
 * Build a SAFE FTS5 MATCH expression from free user input.
 *
 * Strategy (see task constraints — never interpolate raw user input into MATCH):
 *   - split the input into terms the same way `parseTags` does
 *   - strip any double quotes from each term (they would break phrase quoting)
 *   - wrap every term in double quotes so FTS5 treats it as a plain string
 *     (operators like AND/OR/NEAR, parens, `*`, `:` etc. lose their meaning)
 *   - append `*` ONLY to the LAST term → prefix matching for the word being
 *     typed ("supp" matches "supply")
 *   - terms are joined with a space = implicit AND
 *
 * Returns null when the input yields no usable terms (caller should fall back
 * to the legacy LIKE filter for that input).
 */
export function buildFtsMatchQuery(input: string): string | null {
  if (!input) return null;
  const terms = parseTags(input)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms
    .map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}
