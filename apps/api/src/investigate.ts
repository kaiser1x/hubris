// Generalized, evidence-driven CodeTwin investigator (deterministic — no
// model, no exec, no I/O).
//
// Pipeline (per the design brief):
//
//   USER REPORT
//     → REPORT UNDERSTANDING        parse the report into a behavioral claim
//     → CANDIDATE TARGETS           rank a candidate set from subject evidence
//     → RELEVANT EVIDENCE RETRIEVAL reconstruct test scenarios, attribute
//                                   source facts to functions
//     → EVIDENCE RELEVANCE          score each item against the claim
//     → EVIDENCE CLUSTER            build the strongest coherent cluster
//     → BEHAVIORAL CONTRACT         synthesize the repair contract from it
//     → GROUNDING VALIDATION        READY | AMBIGUOUS | NO_MATCH
//
// The governing question is "which repository evidence supports the reported
// behavior?" — never "which facts happen to be near the function I found?".
// Target identification and evidence relevance are separate. Relevance is
// NEVER granted because a fact shares a file/function with the target.
//
// Repository text is evidence, never instructions. No fixture-specific
// vocabulary (payments, carts, sessions, ledger, idempotency, …) is
// hardcoded anywhere in this module — only general English behavior concepts
// used uniformly to match reports to repository evidence.

import {
  conceptsFor,
  contentTokens,
  escapeRe,
  EXPECTATION_MARKERS,
  NEGATION_WORDS,
  splitIdentifier,
  STOPWORDS,
  tokensForMatch,
  tokensMatch,
} from "./text";

export interface TwinFunctionInput {
  name?: string;
  path?: string;
  line?: number;
  // Real end line of the function body (from the analyzer). Absent on
  // legacy twins — fact attribution then falls back to subject-token
  // relevance on the file's facts instead of line ranges.
  endLine?: number;
}

export interface TwinTestInput {
  name?: string;
  path?: string;
  file?: string;
}

export interface TwinRelationshipInput {
  from?: string;
  to?: string;
  type?: string;
  caller?: string;
}

export interface TwinSourceFactInput {
  path?: string;
  line?: number;
  kind?: "source" | "test";
  text?: string;
}

export interface InvestigateInput {
  focus: string;
  functions: TwinFunctionInput[];
  tests: TwinTestInput[];
  relationships: TwinRelationshipInput[];
  sourceFacts?: TwinSourceFactInput[];
}

export interface InvestigationTarget {
  file: string;
  function: string;
}

export interface InvestigationPlan {
  summary: string;
  target: InvestigationTarget;
  currentBehavior: string;
  expectedBehavior: string;
  repairContract: {
    requiredOutcome: string;
    preserveBehavior: string[];
    relevantCondition: string;
    relevantOperation: string;
    existingErrorContract: string;
    minimalRepairDescription: string;
    setupFacts: string[];
    actionFacts: string[];
    observedFacts: string[];
    expectedFacts: string[];
    sourceEvidence: string[];
    relevantAssertions: string[];
    conditionOperationAreDistinct: boolean;
    // Additive: whether relevantCondition is a real guard for the reported
    // behavior, or only an enclosing presence check (the rejecting check is
    // missing from the source).
    conditionKind?: "causal-guard" | "presence-precondition";
  };
  constraints: string[];
  evidence: string[];
  reproduction?: {
    scenario: string;
    testFile: string;
  };
  confidence: "low" | "medium" | "high";
}

// Why an investigation could not establish a repair contract. Lets callers
// tell a genuinely askable ambiguity (several viable interpretations) from a
// hard evidence gap that no answer can fix.
export type AmbiguityCode =
  | "CONTRADICTORY_REPORT"
  | "NO_TEST_SCENARIO"
  | "SCENARIO_DOES_NOT_EXERCISE_TARGET"
  | "SCENARIO_ASSERTS_NOTHING"
  | "CONTRACT_NOT_GROUNDED"
  | "TARGET_UNRESOLVED"
  | "EVIDENCE_UNRESOLVED";

export type InvestigationResult =
  | { status: "READY"; plan: InvestigationPlan; message: string }
  | { status: "AMBIGUOUS"; plan: null; message: string; code?: AmbiguityCode }
  | { status: "NO_MATCH"; plan: null; message: string };


// ---- Report understanding ----

interface ReportClaim {
  subjectTokens: Set<string>;
  // Raw content words of the report, INCLUDING words that map to a behavior
  // concept (e.g. "discount", "total"). Concepts must not replace the raw
  // semantic signal: a concrete noun still discriminates sibling scenarios.
  entityTokens: Set<string>;
  behaviorConcepts: Set<string>;
  // The problem behavior (everything not relegated to the expectation
  // clause). Candidate names that perform the observed behavior are favored;
  // expectation words ("should throw") are NOT treated as the subject's action.
  observedConcepts: Set<string>;
  expectedPositive: Set<string>;
  expectedNegated: Set<string>;
  expectedText: string;
  // The report's own expectation, original case, label stripped and bounded —
  // quoted verbatim in the plan so the user's stronger requirements survive.
  expectedOriginal: string;
  // Message-like quoted strings inside the expectation ("duplicate payment for
  // key"): error text the USER requires, independent of any test substring.
  expectedMessages: string[];
  // The report's own description of the CURRENT behavior (original case,
  // labels stripped, directives and the expectation excluded), bounded.
  observedOriginal: string;
  contradictory: boolean;
}


// Sentences that instruct the investigator ("Investigate why…", "Do not guess…",
// "Preserve the existing error messages") are directives, not statements of
// expected behavior. They must never be read as the report's expectation.
const DIRECTIVE_VERBS = new Set([
  "investigate", "trace", "examine", "identify", "find", "determine", "explain",
  "analyze", "analyse", "inspect", "review", "use", "do", "don't", "dont",
  "keep", "preserve", "ensure", "make", "show", "list", "report", "look",
  "check", "verify", "confirm", "describe", "locate", "focus", "avoid",
  "never", "only", "please", "also", "note",
]);

// Words that sequence an expectation ("accept the FIRST request and reject
// the SECOND"). A positive and a rejecting outcome in one clause are only a
// contradiction when nothing orders them.
const SEQUENCING_WORDS =
  /\b(first|second|third|subsequent|subsequently|initial|initially|later|then|next|original|originally|otherwise|until|unless|afterwards?|thereafter)\b/;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function isDirectiveSentence(sentence: string): boolean {
  const first =
    sentence
      .toLowerCase()
      .replace(/^[\s\-*•>"'`(\d.)]+/, "")
      .split(/[^a-z']+/)[0] ?? "";
  return DIRECTIVE_VERBS.has(first);
}

const EXPECTATION_MARKER_RE = /\b(should|must|ought|ideally|expected|needs?|requires?|wants?)\b/;
const INSTEAD_RE = /\binstead(?:\s+of)?\b/;

// Concept sets for one expectation clause. Negation applies to the next
// concept-bearing token ("should not be usable after it expires" negates
// "expires", not the intervening function words).
function expectationConcepts(clause: string): { positive: Set<string>; negated: Set<string> } {
  const positive = new Set<string>();
  const negated = new Set<string>();
  let pendingNegation = false;
  for (const token of tokensForMatch(clause)) {
    if (NEGATION_WORDS.has(token)) {
      pendingNegation = true;
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    let added = false;
    for (const concept of conceptsFor(token)) {
      if (pendingNegation) negated.add(concept);
      else positive.add(concept);
      added = true;
    }
    if (added) pendingNegation = false;
  }
  return { positive, negated };
}

// "Expected behavior: the second call must throw…" → the clause after the
// label, bounded for display.
function cleanExpectation(text: string): string {
  const cleaned = text
    .replace(/^[\s:,-]*(?:behaviou?r|result|outcome)\b[\s:,-]*(?:is\s+)?(?:to\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

// "Bug: … Current behavior: Calling f() twice creates another payment." →
// the observed clauses without their labels, whitespace collapsed, bounded.
function cleanObserved(parts: string[]): string {
  const cleaned = parts
    .map((p) => p.replace(/^[\s]*(?:bug|issue|problem|current behaviou?r|actual(?: behaviou?r)?|observed(?: behaviou?r)?)\s*[:-]\s*/i, "").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const text = cleaned.join(" ");
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

// Quoted strings that read like user-facing message text (multi-word, no code
// punctuation): the error wording the USER requires. Identifiers, calls, and
// paths in backticks are not messages.
function messageLikeQuotes(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`|"([^"]+)"|“([^”]+)”/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const q = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (q.length < 5 || !/\s/.test(q)) continue;
    if (/[(){}\/]|\.[a-z]{1,4}$/i.test(q)) continue;
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 3);
}

function parseClaim(focus: string): ReportClaim {
  const lower = focus.toLowerCase();
  const allTokens = contentTokens(lower);
  const behaviorConcepts = conceptsFor(lower);

  // Decompose the report SENTENCE by sentence. The expectation is the
  // "should/must/expected" clause of a non-directive sentence, or — when the
  // sentence has no such marker — the clause after "instead of" (which names
  // the desired outcome, e.g. "accepted instead of rejected"). It never spans
  // sentences, so trailing investigation instructions cannot leak into it.
  // Everything else (the part before the marker / "instead of", and
  // directive sentences) describes the current/observed behavior.
  const expectedSegments: string[] = [];
  // Original-case expectation text, split by where it came from: an explicit
  // "should / must / expected" clause is the user's stated expectation; the
  // tail after "instead of" is only a fallback when there is none.
  const markerOriginals: string[] = [];
  const insteadOriginals: string[] = [];
  const observedOriginals: string[] = [];
  const observedParts: string[] = [];
  for (const sentence of splitSentences(focus)) {
    const s = sentence.toLowerCase();
    if (isDirectiveSentence(sentence)) {
      observedParts.push(s);
      continue;
    }
    const observedOriginal = (to: number) =>
      (sentence.length === s.length ? sentence : s).slice(0, to);
    const insteadMatch = INSTEAD_RE.exec(s);
    const insteadIdx = insteadMatch?.index ?? -1;
    const insteadTail = insteadMatch ? s.slice(insteadIdx + insteadMatch[0].length) : "";
    const primary = insteadIdx >= 0 ? s.slice(0, insteadIdx) : s;
    const marker = EXPECTATION_MARKER_RE.exec(primary);
    // Original-case slice of the same range (lowercasing can, rarely, change
    // length; then fall back to the lowercase text rather than misalign).
    const original = (from: number, to?: number) =>
      sentence.length === s.length ? sentence.slice(from, to) : s.slice(from, to);
    if (marker) {
      const from = marker.index + marker[0].length;
      observedParts.push(primary.slice(0, marker.index));
      observedOriginals.push(observedOriginal(marker.index));
      expectedSegments.push(primary.slice(from));
      markerOriginals.push(original(from, primary.length));
      if (insteadIdx >= 0) observedParts.push(insteadTail);
    } else if (insteadIdx >= 0) {
      const from = insteadIdx + (insteadMatch?.[0].length ?? 0);
      observedParts.push(primary);
      expectedSegments.push(insteadTail);
      observedOriginals.push(observedOriginal(primary.length));
      insteadOriginals.push(original(from));
    } else {
      observedParts.push(s);
      observedOriginals.push(observedOriginal(s.length));
    }
  }
  const expectedText = expectedSegments.join(" ").trim();
  const expectedOriginal = cleanExpectation(
    (markerOriginals.length > 0 ? markerOriginals : insteadOriginals).map(cleanExpectation).join(" ")
  );
  const expectedMessages = messageLikeQuotes(expectedOriginal);
  const observedOriginal = cleanObserved(observedOriginals);

  const expectedPositive = new Set<string>();
  const expectedNegated = new Set<string>();
  // Contradiction: ONE expectation clause both demands an affirmative outcome
  // and rejects it (e.g. "should create another payment and also reject the
  // retry"), or asserts the same concept both positively and under negation.
  // A current-vs-expected difference is the bug itself, never a contradiction.
  let contradictory = false;
  for (const segment of expectedSegments) {
    for (const clause of segment.split(/;|\bbut\b/)) {
      const { positive, negated } = expectationConcepts(clause);
      for (const c of positive) expectedPositive.add(c);
      for (const c of negated) expectedNegated.add(c);
      if (
        (positive.has("create") && positive.has("reject") && !SEQUENCING_WORDS.test(clause)) ||
        [...positive].some((c) => negated.has(c))
      ) {
        contradictory = true;
      }
    }
  }

  // Subject tokens: report content words that are not pure behavior words.
  // They name the entity/operation the report is about and drive candidate
  // targeting. Behavior words drive evidence relevance instead.
  const subjectTokens = new Set<string>();
  for (const token of allTokens) {
    if (EXPECTATION_MARKERS.has(token) || NEGATION_WORDS.has(token)) continue;
    if (conceptsFor(token).size > 0) continue;
    subjectTokens.add(token);
  }

  // Entity tokens: every content word that is not expectation/negation filler,
  // INCLUDING concept words. Kept alongside concepts so a concrete noun such as
  // "discount" or "total" can still discriminate between sibling scenarios.
  const entityTokens = new Set<string>();
  for (const token of allTokens) {
    if (EXPECTATION_MARKERS.has(token) || NEGATION_WORDS.has(token)) continue;
    entityTokens.add(token);
  }

  // The problem behavior: concepts stated in the OBSERVED portion of the
  // report (everything before the expectation marker / "instead of"). A
  // concept that appears there is observed — even if the expected clause
  // restates the same operation (e.g. "removes the wrong entry … only the
  // right entry is removed" keeps "remove" as the observed action). A NEGATED
  // expectation ("should not be usable after it expires") also describes the
  // observed problem (the token currently IS usable after expiry), so its
  // concepts stay observed too.
  const observedText = observedParts.join(" ");
  const observedConcepts = new Set([
    ...conceptsFor(observedText),
    ...expectedNegated,
  ]);

  return { subjectTokens, entityTokens, behaviorConcepts, observedConcepts, expectedPositive, expectedNegated, expectedText, expectedOriginal, expectedMessages, observedOriginal, contradictory };
}

// ---- Test scenario reconstruction ----

export interface TestScenario {
  id: string;
  file: string;
  name: string;
  description: string;
  facts: TwinSourceFactInput[];
  // Functions the scenario's assertions target (expect(() => fn(...)).
  asserted: Set<string>;
  // Any function called in the scenario body (setup included).
  called: Set<string>;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function stripExt(p: string): string {
  return p.replace(/\.[^.]*$/, "");
}

function factText(fact: TwinSourceFactInput): string {
  return typeof fact.text === "string" ? fact.text.trim() : "";
}

const IT_OPENER = /(?:^|[\s;(])(it|test)\s*\(\s*['"]([^'"]+)['"]/i;
const ASSERT_CALLER = /(?:expect|await|assert)\(\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/;

// Identifiers that are control/structural words, never target functions.
const NON_CALL_IDENTIFIERS = new Set([
  "if", "for", "while", "do", "switch", "catch", "return", "throw", "expect",
  "it", "test", "describe", "beforeEach", "afterEach", "beforeAll",
  "afterAll", "function", "const", "let", "var", "await", "new", "typeof",
  "instanceof", "import", "require", "describe", "toThrow", "toBe", "toEqual",
  "toBeNull", "toBeTruthy", "toBeFalsy", "toHaveLength", "toBeGreaterThan",
  "toBeLessThan", "toContain", "toBeDefined", "toMatch",
]);

function extractCalls(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name.length < 2 || NON_CALL_IDENTIFIERS.has(name)) continue;
    out.add(name);
  }
  return out;
}

// Group test facts into scenarios. `it('…')`/`test('…')` openers start a
// scenario; facts before any opener, or files without openers, become one
// file-level scenario (legacy twins and compact suites).
export function reconstructScenarios(
  facts: TwinSourceFactInput[],
  testPaths: Set<string>
): TestScenario[] {
  const byFile = new Map<string, TwinSourceFactInput[]>();
  for (const f of facts) {
    if (f.kind === "test" && typeof f.path === "string" && testPaths.has(f.path)) {
      const list = byFile.get(f.path) ?? [];
      list.push(f);
      byFile.set(f.path, list);
    }
  }
  const scenarios: TestScenario[] = [];
  for (const [file, fileFacts] of byFile) {
    const sorted = [...fileFacts].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    let current: TestScenario | null = null;
    for (const f of sorted) {
      const opener = IT_OPENER.exec(factText(f));
      if (opener) {
        current = {
          id: `${file}#${opener[2]}`,
          file,
          name: basename(file),
          description: opener[2],
          facts: [],
          asserted: new Set<string>(),
          called: new Set<string>(),
        };
        scenarios.push(current);
      }
      if (current) current.facts.push(f);
    }
    if (!current) {
      scenarios.push({
        id: file,
        file,
        name: basename(file),
        description: basename(file),
        facts: sorted,
        asserted: new Set<string>(),
        called: new Set<string>(),
      });
    }
  }
  for (const s of scenarios) {
    for (const f of s.facts) {
      const caller = ASSERT_CALLER.exec(factText(f));
      if (caller) s.asserted.add(caller[1]);
      for (const fn of extractCalls(factText(f))) s.called.add(fn);
    }
  }
  return scenarios;
}

// ---- Source fact attribution ----

// Facts that belong to a function: those inside its real line range when
// the twin records it; otherwise any fact in the function's file that shares
// subject/behavior vocabulary with the claim (never "same file ⇒ relevant").
export function factsForFunction(
  fn: TwinFunctionInput,
  fileFacts: TwinSourceFactInput[]
): TwinSourceFactInput[] {
  const inFile = fileFacts;
  if (fn.endLine !== undefined && typeof fn.line === "number" && fn.endLine >= fn.line) {
    return inFile.filter(
      (f) => typeof f.line === "number" && f.line >= fn.line! && f.line <= fn.endLine!
    );
  }
  const nameTokens = splitIdentifier(fn.name ?? "");
  const byName = inFile.filter((f) => {
    const t = factText(f).toLowerCase();
    return nameTokens.some((n) => t.includes(n));
  });
  if (byName.length > 0) return byName;
  return inFile;
}

// ---- Evidence relevance ----

export interface RelevantEvidence {
  scenarios: TestScenario[];
  sourceFacts: TwinSourceFactInput[];
  sourceSelectionFacts: TwinSourceFactInput[];
  // Causally selected source evidence: the operation producing the asserted
  // value and the guard that governs it.
  operationFacts: TwinSourceFactInput[];
  conditionFacts: TwinSourceFactInput[];
  throwFacts: TwinSourceFactInput[];
  valueAssertions: TwinSourceFactInput[];
  relevantAssertions: TwinSourceFactInput[];
  setupFacts: TwinSourceFactInput[];
  actionFacts: TwinSourceFactInput[];
  observedFacts: TwinSourceFactInput[];
  expectedFacts: TwinSourceFactInput[];
  errorParts: string[];
  // How the selected condition relates to the reported behavior:
  //   causal-guard           a real guard (or no throw is expected) — as before
  //   presence-precondition  a throw is expected, no source throw produces it,
  //                          and the only enclosing guard merely tests that a
  //                          value is present: the rejecting check is MISSING
  conditionKind: "causal-guard" | "presence-precondition";
  // The source throw (in the selected functions) whose text matches an
  // asserted error part; null when none exists.
  rejectionPath: TwinSourceFactInput | null;
  // Does the selected write concern what the report is about?
  operationRelevant: boolean;
  // Statement-level calls after the write in the same function: effects a
  // rejected request must not reach.
  laterEffectNames: string[];
  // Error wording the USER requires (quoted in the report's expectation).
  userErrorTexts: string[];
  // The report's own expectation clause (verbatim, bounded).
  reportExpectation: string;
}

const GUARD_PATTERN = /\bif\s*\(|\.has\s*\(|!==|===|!=\s*undefined|throw|\.includes\(/i;
// A mutation is a real state write: a collection/setter call or a single
// assignment. `!==` / `===` / `=>` / `==` are not mutations.
const MUTATION_PATTERN = /\.(?:set|add|push|save|delete|remove|unshift|splice)\s*\(/;
function isMutationFact(text: string): boolean {
  if (MUTATION_PATTERN.test(text)) return true;
  if (/^\s*(?:const|let|var)\b/.test(text)) return false;
  return /(?:^|[.\]])\s*[A-Za-z_$][\w$]*\s*=\s*[^=]/.test(text);
}
const THROW_PATTERN = /toThrow\s*\(|throw new Error|rejects\.to/i;
const VALUE_PATTERN = /expect\([^)]*\)\.(?:toBe|toEqual|toBeNull|toBeTruthy|toHaveLength|toBeGreaterThan|toBeLessThan)/;

function scenarioRelevance(s: TestScenario, claim: ReportClaim): number {
  const text = [s.description, s.file, ...s.facts.map(factText)].join(" ");
  const concepts = conceptsFor(text);
  const tokens = new Set(contentTokens(text));
  let score = 0;
  score += [...claim.subjectTokens].filter((token) => tokens.has(token)).length * 2;
  for (const c of concepts) {
    if (claim.expectedPositive.has(c)) score += 3;
    else if (claim.behaviorConcepts.has(c)) score += 1.5;
  }
  for (const t of tokens) {
    if (subjectOverlapCount([t], claim) > 0) score += 1;
  }
  if (concepts.size === 0 && score < 2) score = 0;
  return score;
}

function relevantScenarios(scenarios: TestScenario[], claim: ReportClaim): TestScenario[] {
  const scored = scenarios
    .map((s) => ({ s, score: scenarioRelevance(s, claim) }))
    .filter(({ s, score }) => {
      if (score <= 0) return false;
      // A scenario is relevant only when it establishes the OBSERVED problem
      // the report describes (a shared observed-behavior concept). Expected
      // outcomes ("should throw") never make unrelated scenarios relevant,
      // and subject-only overlap (a broad noun) is never sufficient.
      const concepts = conceptsFor([s.description, ...s.facts.map(factText)].join(" "));
      const sharesConcept = [...concepts].some((c) => claim.observedConcepts.has(c));
      if (!sharesConcept) return false;
      const sharesSubject = [...tokensForMatch([s.description, s.file, ...s.facts.map(factText)].join(" "))]
        .some((t) => t.length >= 2 && subjectOverlapCount([t], claim) > 0);
      return score >= 2 || sharesSubject;
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((x) => x.s);
}

// Does an assertion fact speak to the reported target/behavior? An assertion
// is relevant when it references the target function, shares a report subject
// token, or shares an observed/expected behavior concept. An assertion that
// invokes a DIFFERENT known twin function — and has no report overlap — is a
// leftover check for another behavior and is excluded. Assertions that only
// use scenario-local variables (e.g. expect(latteLines).toHaveLength(1)) stay,
// because they describe the primary scenario's own behavior.
function assertionRelevant(
  text: string,
  claim: ReportClaim,
  targetName: string,
  knownFunctions: Set<string>
): boolean {
  if (!text) return false;
  if (targetName && text.includes(targetName)) return true;
  for (const token of tokensForMatch(text)) {
    // Entity tokens include subject tokens, so this covers both. A concrete
    // noun in the report ("discount", "total") discriminates even when it also
    // maps to a behavior concept.
    for (const entity of claim.entityTokens) {
      if (tokensMatch(token, entity)) return true;
    }
    for (const concept of conceptsFor(token)) {
      if (
        claim.observedConcepts.has(concept) ||
        claim.expectedPositive.has(concept) ||
        claim.expectedNegated.has(concept)
      ) {
        return true;
      }
    }
  }
  for (const fn of knownFunctions) {
    if (fn && fn !== targetName && text.includes(fn)) return false;
  }
  return true;
}

// Does this scenario exercise the target function (by assertion, call, or a
// literal reference in its facts)?
export function scenarioReferencesTarget(s: TestScenario, targetName: string): boolean {
  if (!targetName) return false;
  if (s.asserted.has(targetName) || s.called.has(targetName)) return true;
  return s.facts.some((f) => factText(f).includes(targetName));
}

// Build the contract evidence bundle from an ALREADY-ORDERED scenario list.
// The order is authoritative: the primary scenario is the caller's entry, and
// this function never re-ranks or substitutes a sibling scenario. Only the
// primary scenario contributes assertions/error contracts.
export function evidenceFromScenarios(
  claim: ReportClaim,
  orderedScenarios: TestScenario[],
  primaryScenario: TestScenario | undefined,
  target: TwinFunctionInput,
  scopedFacts: TwinSourceFactInput[],
  knownFunctions: Set<string>,
  opts: { functions?: TwinFunctionInput[]; selectedFunctionNames?: Set<string> } = {}
): RelevantEvidence {
  const throwFacts: TwinSourceFactInput[] = [];
  const valueAssertions: TwinSourceFactInput[] = [];
  const errorParts: string[] = [];
  for (const f of primaryScenario?.facts ?? []) {
    const t = factText(f);
    if (THROW_PATTERN.test(t)) {
      if (!assertionRelevant(t, claim, target.name ?? "", knownFunctions)) continue;
      throwFacts.push(f);
      const err = t.match(/toThrow\s*\(\s*([^)]*)\)/)?.[1];
      if (err && err.trim()) errorParts.push(err.trim());
    } else if (VALUE_PATTERN.test(t)) {
      if (!assertionRelevant(t, claim, target.name ?? "", knownFunctions)) continue;
      valueAssertions.push(f);
    }
  }
  // `scopedFacts` are exactly the SELECTED, already-scoped evidence. This
  // function never re-searches the repository for other source facts.
  const sourceFactsRelevant = [...scopedFacts]
    .filter((f) => f.kind !== "test")
    .sort(compareFactLocation);
  // What the write must relate to: the report's own words PLUS the selected
  // scenarios (their descriptions and facts, minus the target's own name and
  // test boilerplate). A vague report still gets grounded by the scenario the user
  // picked, but a write sharing nothing with either is never "the" operation.
  const targetTokens = new Set(splitIdentifier(target.name ?? ""));
  const scenarioWords = new Set<string>();
  for (const sc of [primaryScenario, ...orderedScenarios.slice(0, 3)]) {
    if (!sc) continue;
    for (const t of contentTokens([sc.description, ...sc.facts.map(factText)].join(" "))) {
      if (!targetTokens.has(t) && !TEST_BOILERPLATE.has(t)) scenarioWords.add(t);
    }
  }
  const relevanceClaim: ReportClaim = { ...claim, entityTokens: new Set([...claim.entityTokens, ...scenarioWords]) };
  const selection = selectCausalOperation(
    valueAssertions,
    sourceFactsRelevant,
    target,
    opts.functions ?? [],
    opts.selectedFunctionNames ?? new Set<string>(),
    relevanceClaim
  );
  const operationFacts = selection.operation ? [selection.operation] : [];
  // Is the rejection the test asserts already produced by the selected source?
  // A source `throw` whose text matches an asserted error part is the real
  // rejecting path; without one, the check the test needs is MISSING and an
  // enclosing guard that merely tests presence must not be mistaken for it.
  const rejectionPath =
    errorParts.length > 0
      ? sourceFactsRelevant.find(
          (f) => THROW_STATEMENT.test(factText(f)) && errorParts.some((part) => errorPartMatches(part, factText(f)))
        ) ?? null
      : null;
  // When the source does throw the asserted error, the condition that matters
  // is the guard governing THAT throw — even if it sits after the write the
  // generic "closest guard before the write" rule looked at.
  let condition = selection.condition;
  let conditionFunction = selection.conditionFunction;
  if (rejectionPath) {
    const throwFn = functionContaining(rejectionPath, opts.functions ?? []);
    const governing = sourceFactsRelevant.filter(
      (f) =>
        throwFn !== null &&
        factInFunction(f, throwFn) &&
        isGuardFact(factText(f)) &&
        (f.line ?? 0) < (rejectionPath.line ?? 0)
    );
    if (governing.length > 0) {
      condition = governing[governing.length - 1];
      conditionFunction = throwFn;
    }
  }
  const conditionFacts = condition ? [condition] : [];
  // The evidence window shown for the contract is the operation's function up
  // to the operation, plus the condition's function up to the condition — not
  // an arbitrary prefix of unrelated guards.
  const windowFor = (fn: TwinFunctionInput | null, upto: number | undefined) =>
    typeof upto === "number"
      ? sourceFactsRelevant.filter(
          (f) =>
            (fn ? factInFunction(f, fn) : true) &&
            typeof f.line === "number" &&
            f.line <= upto
        )
      : [];
  const sourceSelectionFacts = dedupeKeepOrder([
    ...windowFor(selection.operationFunction, selection.operation?.line),
    ...windowFor(conditionFunction, condition?.line),
  ]).sort(compareFactLocation);
  const scenarioFacts = primaryScenario?.facts ?? [];
  const actionIndex = primaryScenario
    ? scenarioFacts.findIndex((fact) => new RegExp(`\\b${escapeRe(target.name ?? "")}\\s*\\(`).test(factText(fact)))
    : -1;
  const actionFacts = actionIndex >= 0 ? [scenarioFacts[actionIndex]] : [];
  const setupFacts = actionIndex > 0 ? scenarioFacts.slice(0, actionIndex).filter((fact) => !/\b(?:it|test|describe|beforeEach)\s*\(/.test(factText(fact))) : [];
  const relevantAssertions = (actionIndex >= 0 ? scenarioFacts.slice(actionIndex) : scenarioFacts).filter(
    (fact) => /\bexpect\s*\(/.test(factText(fact))
  ).filter((fact) => assertionRelevant(factText(fact), claim, target.name ?? "", knownFunctions));
  const expectedFacts = relevantAssertions;
  const observedFacts = sourceFactsRelevant.filter((fact) => /\b(?:wrong|incorrect|unexpected|bug|fails?|instead)\b/i.test(factText(fact)));
  const conditionKind: RelevantEvidence["conditionKind"] =
    errorParts.length > 0 &&
    !rejectionPath &&
    condition !== null &&
    isPresenceCheck(factText(condition))
      ? "presence-precondition"
      : "causal-guard";
  // Effects after the write that a rejected request must not reach: the
  // callee of each later statement-level call in the write's own function.
  const laterEffectNames: string[] = [];
  if (selection.operation && selection.operationFunction) {
    const opLine = selection.operation.line ?? 0;
    for (const f of sourceFactsRelevant) {
      if (!factInFunction(f, selection.operationFunction) || (f.line ?? 0) <= opLine) continue;
      const callee = factText(f).match(/^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*|[\w$.]+\s*=\s*)?(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[1];
      if (callee && knownFunctions.has(callee) && callee !== target.name && !laterEffectNames.includes(callee)) {
        laterEffectNames.push(callee);
      }
    }
  }
  if (process.env.HUBRIS_DEBUG_INVESTIGATE) {
    console.error("[investigate] contract facts", {
      actionIndex,
      primaryScenario: primaryScenario?.description ?? null,
      scenarioFacts: scenarioFacts.map(factText),
      assertions: relevantAssertions.map(factText),
      operation: operationFacts.map(factText),
      condition: conditionFacts.map(factText),
    });
  }
  return {
    scenarios: orderedScenarios,
    sourceFacts: sourceFactsRelevant,
    sourceSelectionFacts,
    operationFacts,
    conditionFacts,
    throwFacts,
    valueAssertions,
    relevantAssertions,
    setupFacts,
    actionFacts,
    observedFacts,
    expectedFacts,
    errorParts,
    conditionKind,
    rejectionPath,
    operationRelevant: selection.operation ? writeRelevantToClaim(factText(selection.operation), relevanceClaim) : false,
    laterEffectNames: laterEffectNames.slice(0, 3),
    userErrorTexts: claim.expectedMessages,
    reportExpectation: claim.expectedOriginal,
  };
}

function collectRelevantEvidence(
  claim: ReportClaim,
  scenarios: TestScenario[],
  target: TwinFunctionInput,
  sourceFacts: TwinSourceFactInput[],
  knownFunctions: Set<string>,
  functions: TwinFunctionInput[]
): RelevantEvidence {
  // Legacy path only: rank the repository's scenarios with the deterministic
  // coherence scorer. The agent path does NOT use this — it supplies the
  // selected evidence order directly, so the deterministic layer cannot
  // override it.
  const relevant = relevantScenarios(scenarios, claim)
    .sort((a, b) => {
      const coherence = (scenario: TestScenario) => scenarioCoherence(scenario, claim, target);
      return coherence(b) - coherence(a);
    })
    .slice(0, 3);
  // Legacy scoping: the target's own facts (line range when known).
  const fileFacts = sourceFacts.filter(
    (f) => typeof f.path === "string" && f.path === target.path && f.kind !== "test"
  );
  const scoped = factsForFunction(target, fileFacts);
  return evidenceFromScenarios(claim, relevant, relevant[0], target, scoped, knownFunctions, {
    functions,
  });
}

function factRelevanceToClaim(fact: TwinSourceFactInput, claim: ReportClaim): number {
  const t = factText(fact).toLowerCase();
  if (t.length === 0) return 0;
  let score = 0;
  for (const c of conceptsFor(t)) {
    if (claim.behaviorConcepts.has(c)) score += 2;
  }
  for (const tok of claim.subjectTokens) {
    if (t.includes(tok)) score += 1;
  }
  return score;
}

// Strongest coherent cluster: how much of the scenario is ABOUT the observed
// behavior (concept density), whether its assertions target the candidate,
// and only then subject-noun overlap as a tie-breaker. Behavioral relevance
// always outranks vocabulary overlap.
function scenarioCoherence(scenario: TestScenario, claim: ReportClaim, target: TwinFunctionInput): number {
  const descriptionObserved = [...conceptsFor(scenario.description)].filter((c) =>
    claim.observedConcepts.has(c)
  ).length;
  const factTexts = scenario.facts.map(factText).filter((t) => t.length > 0 && !IT_OPENER.test(t));
  const relevantFacts = factTexts.filter((t) =>
    [...conceptsFor(t)].some((c) => claim.observedConcepts.has(c))
  ).length;
  const density = factTexts.length > 0 ? relevantFacts / factTexts.length : 0;
  const tokens = new Set(contentTokens([scenario.description, ...factTexts].join(" ")));
  const subjectOverlap = [...claim.subjectTokens].filter((token) => tokens.has(token)).length;
  // A scenario NAMED for the reported subject is a deliberate test of that
  // behavior; unrelated facts inside a broader scenario are not.
  const descriptionTokens = new Set(contentTokens(scenario.description));
  const descriptionSubject = [...claim.subjectTokens].filter((token) =>
    [...descriptionTokens].some((t) => tokensMatch(t, token))
  ).length;
  const name = target.name ?? "";
  return (
    descriptionObserved * 6 +
    Math.min(descriptionSubject, 3) * 3 +
    relevantFacts * 3 +
    density * 4 +
    (scenario.asserted.has(name) ? 4 : 0) +
    (scenario.called.has(name) ? 2 : 0) +
    Math.min(subjectOverlap, 2)
  );
}

function dedupeKeepOrder<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// ---- Causal source linkage (evidence reduction) ----
//
// The contract is built ONLY from the selected, scoped evidence. These helpers
// identify which selected source statement produces the asserted value and
// which selected guard governs it — never by position ("first mutation", "last
// guard"), which is what let unrelated guards and persistence writes win.

// A guard is an enclosing conditional predicate — not a bare terminal throw
// and not a state mutation. (A bare `throw new Error(...)` is a terminal
// branch, not the condition that governs a computation.)
const CONDITION_PATTERN = /\bif\s*\(|\bswitch\s*\(|\.has\s*\(|\.includes\s*\(/;
function isGuardFact(text: string): boolean {
  return CONDITION_PATTERN.test(text) && !isMutationFact(text);
}

// The innermost twin function whose line range contains the fact (same file).
function functionContaining(
  fact: TwinSourceFactInput,
  functions: TwinFunctionInput[]
): TwinFunctionInput | null {
  if (typeof fact.line !== "number") return null;
  let best: TwinFunctionInput | null = null;
  for (const fn of functions) {
    if (typeof fn.line !== "number") continue;
    if (typeof fn.path === "string" && typeof fact.path === "string" && fn.path !== fact.path) {
      continue;
    }
    const end = typeof fn.endLine === "number" ? fn.endLine : fn.line;
    if (fact.line >= fn.line && fact.line <= end) {
      if (!best || (fn.line ?? 0) >= (best.line ?? 0)) best = fn;
    }
  }
  return best;
}

function factInFunction(fact: TwinSourceFactInput, fn: TwinFunctionInput | null): boolean {
  if (!fn || typeof fn.line !== "number" || typeof fact.line !== "number") return false;
  if (typeof fn.path === "string" && typeof fact.path === "string" && fn.path !== fact.path) {
    return false;
  }
  const end = typeof fn.endLine === "number" ? fn.endLine : fn.line;
  return fact.line >= fn.line && fact.line <= end;
}

// The assignment target of a source line: `const total = …` → "total",
// `order.total = …` → "total". Null for non-assignments (e.g. `.set(...)`).
function assignmentTarget(text: string): string | null {
  const decl = text.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (decl) return decl[1].toLowerCase();
  const asg = text.match(
    /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\+|-|\*|\/|%|\|\||&&|\?\?)?=(?!=|>)/
  );
  if (asg) {
    const seg = asg[1].split(".").pop() ?? "";
    return seg ? seg.toLowerCase() : null;
  }
  return null;
}

// The last identifier of the asserted subject, e.g. `expect(order.total)` →
// "total". This is the value the operation must produce.
function assertedSubjectToken(valueAssertions: TwinSourceFactInput[]): string | null {
  for (const f of valueAssertions) {
    const m = factText(f).match(/expect\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/);
    if (m) {
      const last = m[1].split(".").pop();
      if (last) return last.toLowerCase();
    }
  }
  return null;
}

interface CausalSelection {
  operation: TwinSourceFactInput | null;
  condition: TwinSourceFactInput | null;
  operationFunction: TwinFunctionInput | null;
  conditionFunction: TwinFunctionInput | null;
}

// Stable source order: by file, then line. Never compares line numbers of
// different files.
function compareFactLocation(a: TwinSourceFactInput, b: TwinSourceFactInput): number {
  const pa = a.path ?? "";
  const pb = b.path ?? "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

// Operation = the selected assignment to the asserted subject, else the first
// selected mutation. Condition = a guard in a SELECTED helper the operation
// calls, else the closest guard before the operation in its own function.
// Verbs of the write itself carry no subject information.
const WRITE_WORDS = new Set(["add", "set", "push", "save", "delete", "remove", "unshift", "splice", "new"]);

// Does a write concern what the report is about? True when an identifier in
// the statement shares a content word with the report (idempotency / key ↔
// seenIdempotencyKeys.add(idempotencyKey)); an unrelated write (LEDGER.push)
// shares none.
function writeRelevantToClaim(text: string, claim: ReportClaim): boolean {
  for (const token of tokensForMatch(text)) {
    if (token.length < 3 || STOPWORDS.has(token) || WRITE_WORDS.has(token)) continue;
    for (const entity of claim.entityTokens) {
      if (entity.length >= 3 && tokensMatch(token, entity)) return true;
    }
  }
  return false;
}

// A guard that only tests whether a value is PRESENT (`x !== undefined`,
// `x != null`, `!x`, `typeof x !== "undefined"`). It decides nothing about
// whether the value was used before.
function isPresenceCheck(guardText: string): boolean {
  const m = guardText.match(/\bif\s*\((.*)\)/);
  if (!m) return false;
  const expr = m[1].trim();
  const id = "[A-Za-z_$][\\w$]*(?:\\??\\.[A-Za-z_$][\\w$]*)*";
  return (
    new RegExp(`^!{0,2}\\s*${id}$`).test(expr) ||
    new RegExp(`^${id}\\s*(?:!==|!=|===|==)\\s*(?:undefined|null)$`).test(expr) ||
    new RegExp(`^typeof\\s+${id}\\s*(?:!==|!=|===|==)\\s*["']undefined["']$`).test(expr)
  );
}

// Does an asserted error part (a string or a /regex/flags literal from
// `toThrow(...)`) match this source text?
function errorPartMatches(part: string, text: string): boolean {
  const re = part.match(/^\/(.+)\/([a-z]*)$/);
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(text);
    } catch {
      return false;
    }
  }
  const literal = part.replace(/^["'`]|["'`]$/g, "");
  return literal.length > 0 && text.includes(literal);
}

const TEST_BOILERPLATE = new Set(["expect", "tothrow", "throw", "throws", "describe", "test", "each", "not", "tobe", "toequal", "tocontain"]);
// `expect(() => f(1)).toThrow("x")` → `the repository test expects f(1) to throw "x"`
// (shorter than the raw assertion, which the contract carries verbatim anyway).
function describeThrowAssertion(assertion: string): string {
  const m = assertion.match(/expect\(\s*\(\)\s*=>\s*(.+?)\s*\)\s*\.toThrow\(\s*(.*?)\s*\)\s*;?\s*$/);
  return m ? `the repository test expects ${m[1]} to throw ${m[2] || "an error"}` : `the repository test asserts ${assertion}`;
}

const THROW_STATEMENT = /\bthrow\s+new\b|^\s*throw\b/;

function selectCausalOperation(
  valueAssertions: TwinSourceFactInput[],
  scopedFacts: TwinSourceFactInput[],
  target: TwinFunctionInput,
  functions: TwinFunctionInput[],
  selectedFunctionNames: Set<string>,
  claim?: ReportClaim
): CausalSelection {
  // Facts from the TARGET function come first: its own writes and guards are
  // the causal chain. Callee facts (other functions, other files) follow, and
  // line numbers only order facts WITHIN a file — comparing line numbers
  // across files let an unrelated helper's early line win over the target.
  const sorted = [...scopedFacts].sort((a, b) => {
    const rank = (f: TwinSourceFactInput) => (factInFunction(f, target) ? 0 : 1);
    return rank(a) - rank(b) || compareFactLocation(a, b);
  });
  const subject = assertedSubjectToken(valueAssertions);

  let operation: TwinSourceFactInput | null = null;
  if (subject) {
    const assignments = sorted.filter((f) => assignmentTarget(factText(f)) === subject);
    // Prefer an assignment inside the target function; the last one is the
    // value the assertion observes.
    const inTarget = assignments.filter((f) => factInFunction(f, target));
    const pool = inTarget.length > 0 ? inTarget : assignments;
    if (pool.length > 0) operation = pool[pool.length - 1];
  }
  if (!operation) {
    // Prefer the write that concerns the report; within that, the target's own
    // write before a callee's. With no related write, the first write as before.
    const mutations = sorted.filter((f) => isMutationFact(factText(f)));
    const related = claim ? mutations.filter((f) => writeRelevantToClaim(factText(f), claim)) : [];
    operation =
      related.find((f) => factInFunction(f, target)) ??
      mutations.find((f) => factInFunction(f, target)) ??
      related[0] ??
      mutations[0] ??
      null;
  }
  if (!operation) {
    return { operation: null, condition: null, operationFunction: null, conditionFunction: null };
  }

  const operationFunction = functionContaining(operation, functions);
  const called = extractCalls(factText(operation));

  // 1. A guard inside a SELECTED helper function that the operation calls.
  let condition: TwinSourceFactInput | null = null;
  let conditionFunction: TwinFunctionInput | null = null;
  const helper = functions.find(
    (fn) =>
      typeof fn.name === "string" &&
      fn.name.length > 0 &&
      fn.name !== target.name &&
      selectedFunctionNames.has(fn.name) &&
      called.has(fn.name)
  );
  if (helper) {
    const guards = sorted.filter((f) => factInFunction(f, helper) && isGuardFact(factText(f)));
    if (guards.length > 0) {
      condition = guards[guards.length - 1];
      conditionFunction = helper;
    }
  }
  // 2. Otherwise the closest guard before the operation in its own function
  //    (or anywhere in the selected set when the range is unknown).
  if (!condition) {
    const guards = sorted.filter(
      (f) =>
        (operationFunction ? factInFunction(f, operationFunction) : true) &&
        isGuardFact(factText(f)) &&
        typeof f.line === "number" &&
        typeof operation.line === "number" &&
        f.line < operation.line
    );
    if (guards.length > 0) {
      condition = guards[guards.length - 1];
      conditionFunction = operationFunction;
    }
  }
  return { operation, condition, operationFunction, conditionFunction };
}

// ---- Repair contract synthesis (evidence-driven, provenance-bound) ----

function buildRepairContract(
  claim: ReportClaim,
  evidence: RelevantEvidence,
  target: TwinFunctionInput
): InvestigationPlan["repairContract"] {
  // Causal evidence selected from the authoritative evidence set — never
  // re-derived here.
  const conditionFacts = evidence.conditionFacts;
  const operationFacts = evidence.operationFacts;
  const relevantScenario = evidence.scenarios[0];
  const missingCheck = evidence.conditionKind === "presence-precondition";

  // requiredOutcome — grounded in the concrete assertion the relevant
  // scenario actually makes. Never a generic template when a concrete value
  // is available (spec §9).
  let requiredOutcome = "";
  if (evidence.throwFacts.length > 0) {
    requiredOutcome = `Must throw: ${factText(evidence.throwFacts[0])}`;
  } else if (evidence.valueAssertions.length > 0 && operationFacts.length > 0) {
    requiredOutcome = `The existing operation must produce the result the repository test asserts: ${factText(evidence.valueAssertions[0])}`;
  } else if (evidence.valueAssertions.length > 0) {
    requiredOutcome = `The computed value must match the repository assertion: ${factText(evidence.valueAssertions[0])}`;
  }

  // existingErrorContract — three separately labeled sources, never blended:
  //   1. what the TEST asserts (a substring/pattern check, not the message),
  //   2. what the USER requires (quoted in the report),
  //   3. whether the SOURCE already throws it.
  const errorParts = evidence.errorParts;
  const userTexts = evidence.userErrorTexts;
  const errorSentences: string[] = [];
  if (errorParts.length > 0) {
    errorSentences.push(
      `Related tests require an error matching: ${errorParts.join(", ")} (substring/pattern check, not the full message).`
    );
  }
  if (userTexts.length > 0) {
    errorSentences.push(
      `Report requires ${userTexts.map((t) => `"${t}"`).join(", ")} (keep exactly).`
    );
  }
  if (evidence.rejectionPath) {
    errorSentences.push(`Existing source throws: ${factText(evidence.rejectionPath)}`);
  } else if (errorParts.length > 0 || userTexts.length > 0) {
    errorSentences.push(
      "No source throw with this text was found."
    );
  }
  const existingErrorContract = errorSentences.join(" ");

  // relevantCondition — a real guard is reported as such. When the test needs a
  // rejection the source never produces and the only enclosing guard merely
  // tests presence, say so: that guard is NOT the check that rejects the case.
  let relevantCondition = "";
  if (conditionFacts.length > 0) {
    const guard = factText(conditionFacts[conditionFacts.length - 1]);
    relevantCondition = missingCheck
      ? `Repository condition: none found that rejects the case. The only enclosing guard, ${guard}, tests presence, not prior use.`
      : `Repository condition: selection predicate ${guard}`;
  } else if (operationFacts.length > 0) {
    const split = splitConditionalMutation(factText(operationFacts[0]));
    if (split.condition) relevantCondition = `Repository condition: selection predicate ${split.condition}`;
  }

  let relevantOperation = "";
  if (operationFacts.length > 0) {
    const split = splitConditionalMutation(factText(operationFacts[0]));
    relevantOperation = `Repository operation: ${split.operation ?? factText(operationFacts[0])}`;
  }

  const preserveBehavior: string[] = [];
  if (relevantScenario) {
    preserveBehavior.push(`Keep the scenario "${relevantScenario.description}" (${relevantScenario.file}) passing.`);
  }
  if (userTexts.length > 0) {
    preserveBehavior.push(`Keep the required error message wording: ${userTexts.map((t) => `"${t}"`).join(", ")}.`);
  }
  if (errorParts.length > 0 && evidence.rejectionPath) {
    preserveBehavior.push(`Preserve the existing error contract: ${errorParts.join(", ")}.`);
  }

  let minimalRepairDescription = "";
  // A missing rejecting check can only be grounded on a write that concerns
  // the report; an unrelated write (a ledger append) never anchors it.
  const groundable = !missingCheck || evidence.operationRelevant;
  if (requiredOutcome && relevantCondition && relevantOperation && groundable) {
    const selectionEvidence = evidence.sourceSelectionFacts.some((fact) =>
      /\bfor\s*\(|\.keys\s*\(|\.get\s*\(/.test(factText(fact))
    );
    if (missingCheck) {
      const opText = factText(operationFacts[0]);
      const receiver = opText.match(/([A-Za-z_$][\w$]*)\s*\.\s*(?:add|set|push|unshift)\s*\(/)?.[1];
      const later =
        evidence.laterEffectNames.length > 0
          ? `, before ${evidence.laterEffectNames.map((n) => `${n}()`).join(", ")} can run`
          : "";
      minimalRepairDescription =
        `Add the missing check: before ${opText.trim()} ` +
        `${receiver ? `look for an already-recorded entry in ${receiver} and ` : ""}` +
        `throw the required error on a repeat${later}; ` +
        "first-time requests and unrelated behavior stay unchanged.";
    } else {
      minimalRepairDescription = selectionEvidence && /delete|remove/i.test(relevantOperation)
        ? "Preserve the existing setup and mutation; correct the target-selection identity so the existing operation affects the requested entity and no unrelated matching entity."
        : "Preserve the existing condition and operation; make the smallest evidence-backed change before the operation and do not alter unrelated behavior.";
    }
  }

  return {
    requiredOutcome,
    preserveBehavior: preserveBehavior.slice(0, 4),
    relevantCondition,
    relevantOperation,
    existingErrorContract,
    minimalRepairDescription,
    setupFacts: evidence.setupFacts.slice(0, 6).map(factText).filter(Boolean),
    actionFacts: evidence.actionFacts.slice(0, 3).map(factText).filter(Boolean),
    observedFacts: evidence.observedFacts.slice(0, 4).map(factText).filter(Boolean),
    expectedFacts: evidence.expectedFacts.slice(0, 6).map(factText).filter(Boolean),
    sourceEvidence: evidence.sourceSelectionFacts.slice(0, 8).map(factText).filter(Boolean),
    relevantAssertions: evidence.relevantAssertions.slice(0, 6).map(factText).filter(Boolean),
    conditionOperationAreDistinct: Boolean(
      relevantCondition && relevantOperation && relevantCondition !== relevantOperation
    ),
    conditionKind: evidence.conditionKind,
  };
}

function splitConditionalMutation(text: string): { condition: string | null; operation: string | null } {
  const match = text.match(/^\s*if\s*\(([^)]*)\)\s*(?:\{\s*)?(.*?)(?:\s*\})?\s*$/);
  if (!match) return { condition: null, operation: null };
  return {
    condition: `if (${match[1].trim()})`,
    operation: match[2].trim() || null,
  };
}

// ---- Grounding validation ----

export function isGroundedRepairContract(
  contract: InvestigationPlan["repairContract"] | null | undefined
): boolean {
  if (!contract) return false;
  if (process.env.HUBRIS_DEBUG_INVESTIGATE) console.error("[investigate] contract", contract);
  return Boolean(
      contract.requiredOutcome &&
      contract.relevantCondition &&
      contract.relevantOperation &&
      contract.minimalRepairDescription &&
      contract.sourceEvidence.length >= 2 &&
      contract.relevantAssertions.length > 0 &&
      contract.conditionOperationAreDistinct !== false &&
      contract.relevantCondition !== contract.relevantOperation
  );
}

function subjectOverlapCount(tokens: string[], claim: ReportClaim): number {
  let n = 0;
  for (const t of tokens) {
    let hit = false;
    for (const part of tokensForMatch(t)) {
      for (const s of claim.subjectTokens) {
        if (tokensMatch(part, s)) {
          n++;
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
  }
  return n;
}

function candidateScore(
  fn: TwinFunctionInput,
  claim: ReportClaim,
  relevantScenarios: TestScenario[],
  endpointHandlers: Map<string, Array<{ method: string; path: string }>>,
  name: string,
  filePath: string
): { score: number; evidence: string[]; subject: number; observedBehavior: number; scenarioLinkage: number } {
  const evidence: string[] = [];
  let score = 0;
  const nameHits = subjectOverlapCount(splitIdentifier(name), claim);
  if (nameHits > 0) {
    score += 3 * nameHits;
    evidence.push(`Function ${name} matches the reported subject`);
  }
  const pathHits = subjectOverlapCount(splitIdentifier(filePath), claim);
  if (pathHits > 0) {
    score += pathHits;
    if (nameHits === 0) evidence.push(`File ${filePath} matches the reported subject`);
  }
  // Linkage to relevant scenarios: a scenario that asserts on this function
  // is the strongest signal; a scenario that merely calls it (setup) is weak
  // and capped so ubiquitous setup helpers cannot run away with the score.
  const asserted = relevantScenarios.filter((s) => s.asserted.has(name)).length;
  const called = Math.min(relevantScenarios.filter((s) => s.called.has(name)).length, 2);
  if (asserted > 0) {
    score += 3 * asserted;
    evidence.push(`Asserted by ${asserted} relevant test scenario(s)`);
  }
  if (called > 0) {
    score += called;
  }
  // The function performs the reported (observed) behavior: e.g. removeItem
  // performs "remove". This outranks an incidental subject collision ("line")
  // so the function that does the reported action wins. The boost only counts
  // when the candidate is otherwise connected to the report (subject, path,
  // or a relevant scenario) — otherwise generic verbs ("add"/"create") would
  // lift every function with the same prefix.
  const nameConcepts = conceptsFor(name);
  const observedMatches = [...nameConcepts].filter((c) => claim.observedConcepts.has(c)).length;
  const connected = nameHits > 0 || pathHits > 0 || asserted > 0 || called > 0;
  if (observedMatches > 0 && connected) {
    score += 4 * observedMatches;
    evidence.push(`Function ${name} performs the reported behavior`);
  }
  for (const ep of endpointHandlers.get(name) ?? []) {
    if (subjectOverlapCount(splitIdentifier(`${ep.method} ${ep.path}`), claim) > 0) {
      score += 1;
      evidence.push(`Handles ${ep.method} ${ep.path}`);
    }
  }
  return {
    score,
    evidence,
    subject: 3 * nameHits + pathHits,
    observedBehavior: observedMatches > 0 && connected ? 4 * observedMatches : 0,
    scenarioLinkage: 3 * asserted + called,
  };
}

function expectedBehaviorFor(
  claim: ReportClaim,
  focus: string,
  evidence?: RelevantEvidence
): string {
  // Concrete evidence wins over every generic template (spec §9): if a
  // relevant scenario asserts a value, preserve that exact expectation.
  const concrete = evidence?.valueAssertions?.[0]
    ? factText(evidence.valueAssertions[0])
    : "";
  if (concrete) {
    return `The reported behavior must produce the result the repository test asserts: ${concrete}`;
  }
  // A throw assertion is concrete evidence too. It must win over the generic
  // "right entity" template below: that template describes selection-identity
  // bugs (a delete hitting the wrong entry) and fired for ANY report merely
  // because the test calls the target and the source contains some write.
  if (evidence && evidence.throwFacts.length > 0) {
    const parts = [`Rejected with an error: ${describeThrowAssertion(factText(evidence.throwFacts[0]))}.`];
    const stated = evidence.reportExpectation;
    const unstated = evidence.userErrorTexts.filter((t) => !stated.toLowerCase().includes(t.toLowerCase()));
    if (unstated.length > 0) {
      parts.push(`The report requires the message to contain ${unstated.map((t) => `"${t}"`).join(", ")}.`);
    }
    if (stated) parts.push(`Report expectation: ${stated}`);
    return parts.join(" ");
  }
  if (evidence && evidence.actionFacts.length > 0 && evidence.sourceFacts.some((f) => isMutationFact(factText(f)))) {
    return "The requested entity must be the one affected by the existing operation; other matching entities must remain unchanged.";
  }
  if (claim.expectedPositive.has("reject") || claim.expectedNegated.has("create")) {
    return "The reported behavior must be rejected using the existing repository contract.";
  }
  if (claim.expectedPositive.has("duplicate") || claim.behaviorConcepts.has("duplicate")) {
    return "A retry or repeated operation must not produce the reported duplicate behavior.";
  }
  if (claim.expectedPositive.has("calculate") || claim.behaviorConcepts.has("incorrect")) {
    return "The reported value must be computed correctly while existing behavior remains unchanged.";
  }
  if (claim.behaviorConcepts.size > 0) {
    return "The reported behavior should no longer occur while existing behavior remains unchanged elsewhere.";
  }
  return focus.slice(0, 80);
}

const MAX_EVIDENCE = 8;
const MAX_CONSTRAINTS = 6;
const FOCUS_ECHO_CHARS = 160;

// Compose the focus string the structured Forge endpoint consumes. Built
// ONLY from the verified plan (target, behaviors, constraints) — compact
// enough for the Forge contract. The web mirror lives in
// apps/web/app/lib/forge-run.ts and is tested there identically.
export function composeForgeFocus(plan: InvestigationPlan): string {
  const c = plan.repairContract;
  // The evidence chain repeats facts the contract already states, so it comes
  // AFTER the unique content (constraints) and lists only non-empty sections:
  // when the 2000-character budget runs out, only the repetition is cut.
  const chain: Array<[string, string[]]> = [
    ["Setup", c.setupFacts],
    ["Action", c.actionFacts],
    ["Observed", c.observedFacts],
    ["Expected", c.expectedFacts],
    ["Source", c.sourceEvidence],
    ["Assertions", c.relevantAssertions.join(" ") === c.expectedFacts.join(" ") ? [] : c.relevantAssertions],
  ];
  const evidenceChain = chain
    .filter(([, facts]) => facts.length > 0)
    .map(([label, facts]) => `${label}: ${facts.join(" ")}`)
    .join(" ");
  const text = [
    `Target: ${plan.target.function} (${plan.target.file}). Current: ${plan.currentBehavior} Expected: ${plan.expectedBehavior}`,
    `Repair contract: Required outcome: ${c.requiredOutcome} Preserve: ${c.preserveBehavior.join(" ")} Condition: ${c.relevantCondition} Operation: ${c.relevantOperation} Error: ${c.existingErrorContract} Minimal repair: ${c.minimalRepairDescription}`,
    `Constraints: ${plan.constraints.join(" ")}`,
    `Evidence chain: ${evidenceChain}`,
    `Evidence: ${plan.evidence.join(" ")}`,
  ].join(" ");
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

export function investigateTwin(input: InvestigateInput): InvestigationResult {
  try {
    return investigate(input);
  } catch {
    // Total function: malformed twin shapes degrade to NO_MATCH, never throw.
    return { status: "NO_MATCH", plan: null, message: "Unable to read the analysis twin." };
  }
}

function investigate(input: InvestigateInput): InvestigationResult {
  const focus = typeof input.focus === "string" ? input.focus.trim() : "";
  const functions = Array.isArray(input.functions) ? input.functions : [];
  const tests = Array.isArray(input.tests) ? input.tests : [];
  const relationships = Array.isArray(input.relationships) ? input.relationships : [];
  const sourceFacts = Array.isArray(input.sourceFacts) ? input.sourceFacts : [];
  if (focus.length === 0 || functions.length === 0) {
    return {
      status: "NO_MATCH",
      plan: null,
      message:
        focus.length === 0
          ? "No bug description was provided."
          : "No function, file, or test in the analyzed twin matches the description.",
    };
  }

  const claim = parseClaim(focus);
  if (process.env.HUBRIS_DEBUG_INVESTIGATE) {
    console.error("[investigate]", focus.slice(0, 60), {
      subject: [...claim.subjectTokens],
      behavior: [...claim.behaviorConcepts],
      observed: [...claim.observedConcepts],
      expected: [...claim.expectedPositive],
    });
  }
  if (claim.contradictory) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: "The report contains contradictory requirements (both accepting and rejecting the same behavior).",
    };
  }

  // Test file paths from the twin.
  const testPaths = new Set<string>();
  for (const t of tests) {
    const p = typeof t.path === "string" && t.path.length > 0 ? t.path : t.file;
    if (p) testPaths.add(p);
  }
  const scenarios = reconstructScenarios(sourceFacts, testPaths);
  const relevant = relevantScenarios(scenarios, claim);

  // Endpoint handlers indexed from CALLS edges.
  const endpointHandlers = new Map<string, Array<{ method: string; path: string }>>();
  for (const r of relationships) {
    if (r.type !== "CALLS") continue;
    const caller = typeof r.caller === "string" && r.caller.length > 0 ? r.caller : r.from;
    const to = typeof r.to === "string" ? r.to : "";
    if (typeof caller !== "string" || !to || !caller.startsWith("endpoint:")) continue;
    if (caller.includes(" ")) continue;
    const entry = endpointHandlers.get(to) ?? [];
    const label = caller.slice("endpoint:".length);
    const [method, ...rest] = label.split(":");
    entry.push({ method: method ?? "", path: rest.join(":") });
    endpointHandlers.set(to, entry);
  }

  // Ranked candidate set — never collapse to the first match.
  const candidates = functions.map((fn, index) => {
    const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : "(anonymous)";
    const filePath = typeof fn.path === "string" && fn.path.length > 0 ? fn.path : "(unknown)";
    const breakdown = candidateScore(
      fn, claim, relevant, endpointHandlers, name, filePath
    );
    return { index, fn, name, path: filePath, ...breakdown };
  });
  if (process.env.HUBRIS_DEBUG_INVESTIGATE) {
    const top10 = [...candidates].sort((a, b) => b.score - a.score).slice(0, 10);
    console.error("[investigate] top 10 candidates:");
    for (const c of top10) {
      console.error(
        `  ${c.name.padEnd(22)} ${c.path} score=${c.score} subject=${c.subject} observedBehavior=${c.observedBehavior} scenarioLinkage=${c.scenarioLinkage}`
      );
    }
    console.error("[investigate] relevant scenarios:", relevant.map((s) => `"${s.description}" in ${s.file}`).slice(0, 6));
  }
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index);
  const top = ranked[0];

  if (!top || top.score <= 0) {
    return {
      status: "NO_MATCH",
      plan: null,
      message: `No function, file, or test in the analyzed twin connects to "${focus.slice(0, FOCUS_ECHO_CHARS)}".`,
    };
  }

  // Multiple candidates with comparable support → ambiguous.
  const tied = ranked.filter((c) => c.score === top.score);
  if (tied.length > 1 && top.score > 0) {
    const names = tied.slice(0, 5).map((c) => `${c.name} (${c.path})`);
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `Multiple plausible targets match the report: ${names.join("; ")}. Add the failing behavior or a more specific term.`,
    };
  }

  const knownFunctions = new Set(
    functions
      .map((f) => (typeof f.name === "string" ? f.name : ""))
      .filter((n) => n.length > 0)
  );
  const evidence = collectRelevantEvidence(claim, scenarios, top.fn, sourceFacts, knownFunctions, functions);
  const relevantScenario = evidence.scenarios[0];
  if (process.env.HUBRIS_DEBUG_INVESTIGATE) {
    console.error("[investigate] EVIDENCE CLUSTER for target", top.name);
    if (relevantScenario) {
      console.error(`  relevant scenario: "${relevantScenario.description}" in ${relevantScenario.file}`);
      console.error("  scenario asserted:", [...relevantScenario.asserted].join(", "));
      console.error("  scenario called:", [...relevantScenario.called].slice(0, 8).join(", "));
    }
    for (const f of evidence.sourceFacts.slice(0, 6)) {
      console.error(`  source fact ${f.path}:${f.line}: ${factText(f).slice(0, 90)}`);
    }
    console.error(
      `  throwFacts=${evidence.throwFacts.length} valueAssertions=${evidence.valueAssertions.length} errorParts=${evidence.errorParts.join(" | ")}`
    );
  }

  // Target grounded but no behaviorally-relevant scenario → ambiguous.
  if (!relevantScenario) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The repository connects "${top.name}" to the report, but no test scenario or source evidence establishes the reported behavior. Refine the description with the failing behavior.`,
    };
  }

  // Expected outcome must be established by the relevant scenario.
  if (evidence.throwFacts.length === 0 && evidence.valueAssertions.length === 0) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The relevant test scenario "${relevantScenario.description}" does not assert an expected outcome for the reported behavior.`,
    };
  }

  // Source evidence: the target function must contain a condition and an
  // operation causally connected to the claim.
  const contract = buildRepairContract(claim, evidence, top.fn);
  if (!isGroundedRepairContract(contract)) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: "The repository identifies a likely target, but does not establish a coherent repair contract grounded in the reported behavior.",
    };
  }

  const runnerUp = ranked[1]?.score ?? 0;
  return assemblePlan({
    focus,
    claim,
    targetName: top.name,
    targetPath: top.path,
    evidence,
    contract,
    topEvidence: top.evidence,
    gap: top.score - runnerUp,
  });
}

// Assemble a READY plan from a validated evidence bundle. Shared by the legacy
// deterministic path and the authoritative selected-evidence path so both
// produce identical plan shapes.
function assemblePlan(input: {
  focus: string;
  claim: ReportClaim;
  targetName: string;
  targetPath: string;
  evidence: RelevantEvidence;
  contract: InvestigationPlan["repairContract"];
  topEvidence: string[];
  gap: number;
}): InvestigationResult {
  const contract = input.contract;
  const relevantScenario = input.evidence.scenarios[0];
  const clusterStrong =
    input.evidence.scenarios.length >= 1 &&
    (input.evidence.throwFacts.length + input.evidence.valueAssertions.length) >= 1 &&
    contract.relevantCondition !== "" &&
    contract.relevantOperation !== "";

  const relatedScenarios = input.evidence.scenarios
    .slice(0, 3)
    .map((s) => `Keep "${s.description}" (${s.file}) passing.`);
  const constraints = [
    "Make the smallest possible change.",
    "Preserve existing error messages, return values, and API shapes unless the bug requires changing them.",
    ...relatedScenarios,
  ].slice(0, MAX_CONSTRAINTS);

  const evidenceLines = dedupeKeepOrder([
    ...input.topEvidence.slice(0, 2),
    ...input.evidence.scenarios.slice(0, 2).map(
      (s) => `Relevant test scenario "${s.description}" in ${s.file}`
    ),
    ...input.evidence.sourceSelectionFacts.slice(0, 6).map(
      (f) => `Repository ${f.kind ?? "source"} fact ${f.path}:${f.line}: ${factText(f)}`
    ),
    ...input.evidence.relevantAssertions.slice(0, 4).map(
      (f) => `Relevant assertion ${f.path}:${f.line}: ${factText(f)}`
    ),
    ...(contract.existingErrorContract ? [`Error contract: ${contract.existingErrorContract}`] : []),
  ]).slice(0, MAX_EVIDENCE);

  const confidence: InvestigationPlan["confidence"] =
    clusterStrong && input.gap >= 2 ? "high" : clusterStrong ? "medium" : "low";

  const plan: InvestigationPlan = {
    summary: `The analyzed repository supports ${input.targetName} in ${input.targetPath} as the likely target for this report.`,
    target: { file: input.targetPath, function: input.targetName },
    currentBehavior: `User claim: ${input.claim.observedOriginal || input.focus.replace(/\s+/g, " ").slice(0, FOCUS_ECHO_CHARS)}`,
    expectedBehavior: expectedBehaviorFor(input.claim, input.focus, input.evidence),
    repairContract: contract,
    constraints,
    evidence: evidenceLines,
    ...(relevantScenario
      ? { reproduction: { scenario: relevantScenario.description, testFile: relevantScenario.file } }
      : {}),
    confidence,
  };
  return {
    status: "READY",
    plan,
    message: "The repository evidence supports this repair target. Review the plan before forging.",
  };
}

export interface EvidencePlanInput {
  focus: string;
  // The target function already selected by the RAG/model layer.
  target: TwinFunctionInput;
  // Selected scenarios in AUTHORITATIVE order (best first). Never re-ranked.
  scenarios: TestScenario[];
  // Source facts already scoped to the selected evidence (target + selected
  // helper functions). This function never widens the scope.
  sourceFacts: TwinSourceFactInput[];
  knownFunctions: Set<string>;
  // Twin function ranges (for locating the operation/condition) and the names
  // of the selected source functions (for the causal-helper link).
  functions?: TwinFunctionInput[];
  selectedFunctionNames?: Set<string>;
  // Optional evidence lines (from retrieval) seeded into the plan's list.
  topEvidence?: string[];
  // Selection confidence gap. Selected evidence is authoritative, so a
  // coherent contract is at least medium/high.
  gap?: number;
}

// AUTHORITATIVE path: build a READY plan by VALIDATING AND EXTRACTING from
// already-selected repository evidence. This function never re-selects the
// target and never re-ranks or substitutes scenarios — it only decides whether
// the selected evidence is sufficient and coherent. If not, it fails safe
// (AMBIGUOUS) rather than falling back to a fresh repository-wide search.
export function buildPlanFromEvidence(input: EvidencePlanInput): InvestigationResult {
  const focus = input.focus.trim();
  const target = input.target;
  if (!focus || !target.name || !target.path) {
    return {
      status: "NO_MATCH",
      plan: null,
      message: "No repair target could be resolved from the selected evidence.",
    };
  }
  const claim = parseClaim(focus);
  if (claim.contradictory) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: "The report contains contradictory requirements (both accepting and rejecting the same behavior).",
      code: "CONTRADICTORY_REPORT",
    };
  }
  // Primary = the FIRST SELECTED scenario. The selection is authoritative: we
  // never scan for a different scenario that asserts something. If the selected
  // scenario does not assert the reported behavior, that is insufficient
  // evidence (AMBIGUOUS) — not a licence to substitute a sibling.
  const primary = input.scenarios[0];
  if (!primary) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The selected evidence does not include a test scenario exercising "${target.name}".`,
      code: "NO_TEST_SCENARIO",
    };
  }
  // The selected scenario must actually exercise the selected target. This is
  // a rejection check only — it never substitutes another scenario.
  if (!scenarioReferencesTarget(primary, target.name ?? "")) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The selected test scenario "${primary.description}" does not exercise "${target.name}".`,
      code: "SCENARIO_DOES_NOT_EXERCISE_TARGET",
    };
  }
  // Scope the source facts to the SELECTED functions when the caller names
  // them. `input.sourceFacts` may be the full twin; this never widens beyond
  // the selection and never searches for other functions.
  const functions = input.functions ?? [];
  const selectedNames = input.selectedFunctionNames ?? new Set<string>();
  const scopedFacts =
    selectedNames.size > 0 && functions.length > 0
      ? input.sourceFacts.filter((fact) =>
          functions.some(
            (fn) => selectedNames.has(fn.name ?? "") && factInFunction(fact, fn)
          )
        )
      : input.sourceFacts;
  const evidence = evidenceFromScenarios(
    claim,
    input.scenarios,
    primary,
    target,
    scopedFacts,
    input.knownFunctions,
    { functions: input.functions, selectedFunctionNames: input.selectedFunctionNames }
  );
  if (evidence.throwFacts.length === 0 && evidence.valueAssertions.length === 0) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The selected test scenario "${primary.description}" does not assert an expected outcome for the reported behavior.`,
      code: "SCENARIO_ASSERTS_NOTHING",
    };
  }
  const contract = buildRepairContract(claim, evidence, target);
  if (evidence.conditionKind === "presence-precondition" && !evidence.operationRelevant) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: `The test needs a rejection that "${target.name}" never produces, but its only write does not concern the report, so no repair point can be grounded.`,
      code: "CONTRACT_NOT_GROUNDED",
    };
  }
  if (!isGroundedRepairContract(contract)) {
    return {
      status: "AMBIGUOUS",
      plan: null,
      message: "The selected evidence does not establish a coherent repair contract grounded in the reported behavior.",
      code: "CONTRACT_NOT_GROUNDED",
    };
  }
  return assemblePlan({
    focus,
    claim,
    targetName: target.name,
    targetPath: target.path,
    evidence,
    contract,
    topEvidence: input.topEvidence ?? [],
    gap: input.gap ?? 2,
  });
}
