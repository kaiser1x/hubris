// Shared lexical/semantic primitives for HUBRIS investigation.
//
// This module is the single source of truth for how report text, repository
// symbols, and test facts are tokenized and compared. The deterministic
// investigator (investigate.ts) and the retrieval layer (retrieval.ts) both
// import from here, so a change to matching semantics can never silently
// diverge between targeting and retrieval.
//
// Nothing here is domain-specific: only general English behavior concepts
// used uniformly to match reports to repository evidence. Repository text is
// evidence, never instructions; this module never executes or interprets it.

// Stopwords removed before any semantic comparison. Includes generic bug
// report filler so a report's noise words never drive targeting.
export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "and", "or", "it", "its",
  "this", "that", "these", "those", "as", "by", "from", "has", "have",
  "had", "not", "no", "when", "what", "why", "how", "which", "who",
  "does", "do", "did", "can", "should", "would", "my", "our", "your",
  "their", "there", "here", "please", "bug", "issue", "problem", "fix",
  "broken", "fail", "fails", "failing", "failure", "wrong", "bad",
  "another", "someone", "somebody", "something", "some", "often",
  "sometimes", "always", "never", "still", "just", "only", "also",
  "after", "before", "during", "within", "without", "then", "than",
  "while", "because", "though", "however", "therefore", "hence",
  "get", "set", "but", "from", "into", "over", "under", "about",
]);

// Report structure markers — expectation framing and negation. These are
// language-level (not domain-level) and drive the claim decomposition.
export const EXPECTATION_MARKERS = new Set([
  "should", "must", "ought", "ideally", "expected", "needs", "need",
  "instead", "required", "requires", "require", "wants", "want",
]);

export const NEGATION_WORDS = new Set([
  "not", "never", "shouldnt", "doesnt", "isnt", "wont",
  "dont", "without", "no",
]);

// General English behavior concepts used to match a report to repository
// evidence. These are domain-agnostic: they apply to payments, carts,
// sessions, orders, authentication, files, queues, and arbitrary logic.
// No fixture-specific vocabulary is present.
export const BEHAVIOR_CONCEPTS: Record<string, string[]> = {
  duplicate: [
    "duplicate", "duplicated", "repeat", "repeated", "repeats", "again",
    "twice", "double", "doubled", "retry", "retries", "retried", "replay",
    "replayed", "once", "single",
  ],
  remove: [
    "remove", "removes", "removed", "removing", "delete", "deletes",
    "deleted", "deleting", "drop", "drops", "dropped", "discard",
  ],
  expire: [
    "expire", "expires", "expired", "expiring", "expiry", "timeout",
    "stale", "lapse", "lapsed", "outdated", "ttl", "lifetime",
    "elapsed", "passed", "overdue", "valid", "validity",
  ],
  reject: [
    "reject", "rejects", "rejected", "rejecting", "throw", "throws",
    "throwing", "error", "errors", "failed", "deny", "denied", "refuse",
    "refused", "block", "blocks", "blocked", "invalid", "invalidate",
    "invalidated",
  ],
  incorrect: [
    "incorrect", "wrong", "mismatch", "mismatched", "unexpected", "faulty",
    "erroneous", "inaccurate", "inconsistent", "off", "overcharged",
    "overpriced", "inflated", "excessive", "expensive",
  ],
  race: [
    "race", "races", "concurrent", "concurrently", "parallel",
    "simultaneous", "simultaneously", "thread",
  ],
  create: [
    "create", "creates", "created", "creating", "add", "adds", "added",
    "adding", "insert", "inserts", "new", "allow", "allows", "allowed",
    "accept", "accepts", "accepted", "process", "processes", "processed",
    "generate", "generates", "generated",
  ],
  mutate: [
    "update", "updates", "updated", "updating", "change", "changes",
    "changed", "modify", "modifies", "modified", "save", "saves", "saved",
    "store", "stores", "stored", "write", "writes", "wrote", "persist",
    "persists", "persisted", "apply", "applies", "applied",
  ],
  guard: [
    "guard", "guards", "check", "checks", "checked", "checking", "validate",
    "validates", "validated", "verify", "verifies", "verified", "ensure",
    "ensures", "assert", "asserts",
  ],
  calculate: [
    "calculate", "calculates", "calculated", "compute", "computes",
    "computed", "sum", "total", "tally", "subtotal", "amount",
    "price", "pricing", "cost", "discount", "promo", "promotion", "coupon",
  ],
};

// Tokens for semantic matching: camelCase and symbol boundaries are split
// BEFORE lowercasing so "createPayment" yields "create", "payment" and
// "getCartTotal" yields "total" — while "unexpected" stays one word.
export function tokensForMatch(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

export function splitIdentifier(raw: string): string[] {
  return tokensForMatch(raw).filter((t) => !STOPWORDS.has(t));
}

// Light plural folding so "keys" meets "key" and "payments" meets
// "payment". Display strings always keep their originals. Derivational
// families (authentication ↔ authenticate, validation ↔ validate) fold via
// the "-ation" → "-ate" rule so reports meet their twin symbols.
export function stem(token: string): string {
  if (token.length > 6 && token.endsWith("ation")) {
    return token.slice(0, -3) + "e";
  }
  if (token.length > 3 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 3 && token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "refunding" contains "refund" (a morphological prefix), but "unexpected"
// does NOT contain "expect" (a mid-word substring). Prefix-only containment:
// suffixes (-ing, -ed, -ation) legitimately extend a word; meaning-changing
// prefixes (un-, re-, in-) never count.
export function containsWord(longer: string, shorter: string): boolean {
  return longer === shorter || longer.startsWith(shorter);
}

// Two tokens match when their stems agree, or one is a prefix of the other —
// e.g. "checked" meets "check", "refunded" meets "refund". The shorter token
// must be at least 5 characters so common short words never match compounds.
export function tokensMatch(a: string, b: string): boolean {
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return true;
  if (sa.length >= 5 && sb.length >= 5 && (sa.startsWith(sb) || sb.startsWith(sa))) {
    return true;
  }
  return false;
}

export function contentTokens(text: string): string[] {
  return tokensForMatch(text).filter((t) => !STOPWORDS.has(t));
}

// Behavior concepts present in a piece of text. Domain-agnostic.
export function conceptsFor(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokensForMatch(text)) {
    for (const [concept, words] of Object.entries(BEHAVIOR_CONCEPTS)) {
      if (words.some((w) => tokensMatch(token, w))) out.add(concept);
    }
  }
  return out;
}
