// Safe diagnostics for a structured edit whose oldText does not exactly
// match the authoritative source (EDIT_CONTEXT_MISMATCH).
//
// Purpose: classify whether a mismatch is a model output error (oldText not
// present in the analyzed source) or a HUBRIS source-consistency problem.
// The comparison is byte-exact; this module never weakens matching. It only
// reports bounded, secret-free facts: lengths, the longest prefix of the
// model's oldText that actually occurs in the source, where it occurs, and
// short snippets around it.

export interface SourceMismatch {
  oldTextLength: number;
  sourceLength: number;
  // Longest prefix of oldText that exists verbatim in the source. 0 means
  // the very first character of the model's oldText is not in the source.
  matchingPrefixChars: number;
  // Earliest source offset where that matching prefix begins (-1 when no
  // character matches).
  sourceOffset: number;
  // First line of the model's oldText (bounded, LF-clean, no full file).
  oldTextSnippet: string;
  // Source text starting at the matching offset (bounded, LF-clean).
  sourceSnippet: string;
}

const SNIPPET_CHARS = 200;

function cleanSnippet(s: string, start: number, len: number): string {
  return s.slice(Math.max(0, start), Math.max(0, start) + len).replace(/\r/g, "");
}

export function describeSourceMismatch(source: string, oldText: string): SourceMismatch {
  const src = typeof source === "string" ? source : "";
  const old = typeof oldText === "string" ? oldText : "";
  const limit = Math.min(old.length, src.length);
  let matching = 0;
  let offset = -1;
  // O(n^2) worst case on pathological inputs, but inputs are capped
  // (oldText <= 4000 chars, blob <= 4 MiB) and this runs once per rejected
  // edit. Step in growing-prefix chunks to bound indexOf scans.
  for (let n = 1; n <= limit; n++) {
    const idx = src.indexOf(old.slice(0, n));
    if (idx === -1) break;
    matching = n;
    offset = idx;
  }
  return {
    oldTextLength: old.length,
    sourceLength: src.length,
    matchingPrefixChars: matching,
    sourceOffset: offset,
    oldTextSnippet: cleanSnippet(old, 0, SNIPPET_CHARS),
    sourceSnippet:
      offset >= 0 ? cleanSnippet(src, offset, SNIPPET_CHARS + 40) : cleanSnippet(src, 0, SNIPPET_CHARS),
  };
}