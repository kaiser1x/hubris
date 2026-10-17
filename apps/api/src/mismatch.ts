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
// Feedback for the single informed redraft after a byte-exact mismatch: the
// exact source lines where the model's oldText starts to match, as a JSON
// string so every space, tab and newline is visible. Bounded to 40 lines of
// the file the model was already shown; matching itself is never relaxed.
export function buildMismatchFeedback(path: string, oldText: string, source: string): string {
  const m = describeSourceMismatch(source, oldText);
  let region = "";
  if (m.sourceOffset >= 0) {
    const startLine = source.slice(0, m.sourceOffset).split("\n").length - 1;
    // Count literal backslash-n as a line break too: a double-escaped oldText
    // has none of the real ones, but spans the same lines.
    const count = Math.min(40, oldText.split(/\n|\\n/).length + 2);
    region = source.split("\n").slice(startLine, startLine + count).join("\n");
  }
  // The model double-escaped line breaks: its decoded oldText holds the two
  // characters "\" "n" exactly where the source has a real newline.
  const doubleEscaped =
    m.matchingPrefixChars < oldText.length &&
    oldText.startsWith("\\n", m.matchingPrefixChars) &&
    source.charAt(m.sourceOffset + m.matchingPrefixChars) === "\n";
  return [
    "Your previous edit plan was rejected before anything was applied:",
    `the oldText for ${path} does not occur in the source byte-for-byte (only its first ${m.matchingPrefixChars} characters match).`,
    doubleEscaped
      ? "Cause: your oldText contains a literal backslash followed by n where the source has a line break. In the JSON, write each line break once as \\n — never \\\\n."
      : "",
    "Whitespace and indentation count. Copy oldText verbatim from the source; do not retype or re-indent it.",
    region
      ? `The exact source lines at that location, as a JSON string (every space and \n is significant):\n${JSON.stringify(region)}`
      : "Copy oldText verbatim from the source excerpts above.",
    "Return the corrected edit plan in the same JSON shape.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
