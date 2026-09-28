// Hybrid retrieval over a persisted CodeTwin (Phase RAG).
//
// This module is the *retrieval* half of the investigation assistant. It is
// fully deterministic — no model, no exec, no I/O — and it is the only path
// by which repository evidence reaches a hypothesis. A model may *ask* for
// evidence and *select* among retrieved units, but it can never manufacture
// evidence: every unit here carries provenance (jobId, repository, ref,
// commitSha) and is derived from the analyzed twin.
//
// Retrieval is hybrid by construction. A candidate's score sums lexical,
// semantic (behavior-concept), structural (name/path), scenario, assertion,
// graph-proximity, location, and subject-overlap signals. Semantic similarity
// alone or lexical similarity alone is never sufficient: a test scenario that
// actually calls/asserts a function outranks a function that merely shares a
// vocabulary token, so getCartTotal() does not beat createOrder() for a
// discount-total report.
//
// Isolation: an index is built for exactly one job. Every unit records that
// job's provenance, and retrieveEvidence can filter by jobId, so evidence
// from another analyzed repository/job can never enter a cluster.

import {
  conceptsFor,
  contentTokens,
  splitIdentifier,
  tokensForMatch,
  tokensMatch,
} from "./text";
import {
  reconstructScenarios,
  type TestScenario,
  type TwinFunctionInput,
  type TwinRelationshipInput,
  type TwinSourceFactInput,
  type TwinTestInput,
} from "./investigate";

export type EvidenceSourceType = "source" | "test" | "graph" | "metadata" | "git";

export interface EvidenceProvenance {
  jobId: string;
  repository: string;
  ref: string | null;
  commitSha: string | null;
}

// The evidence contract (spec §6). Model output is NOT evidence; only units
// shaped like this may back a hypothesis.
export interface Evidence {
  sourceType: EvidenceSourceType;
  file: string;
  line: number;
  function: string | null;
  text: string;
  provenance: {
    jobId: string;
    repository: string;
    ref: string | null;
    commitSha: string | null;
  };
}

export interface RetrievalUnit {
  id: string;
  sourceType: EvidenceSourceType;
  file: string;
  line: number;
  endLine: number | null;
  function: string | null;
  testScenario: string | null;
  assertions: string[];
  text: string;
  provenance: EvidenceProvenance;
}

export interface RetrievalIndexInput {
  jobId: string;
  repository: string;
  ref?: string | null;
  commitSha?: string | null;
  functions: TwinFunctionInput[];
  tests: TwinTestInput[];
  relationships: TwinRelationshipInput[];
  sourceFacts: TwinSourceFactInput[];
  scripts?: Record<string, string>;
  packageManager?: string | null;
  recentCommits?: Array<{ sha: string; subject: string; date?: string }>;
}

export interface RetrievalIndex {
  provenance: EvidenceProvenance;
  units: RetrievalUnit[];
  scenarios: TestScenario[];
  functions: TwinFunctionInput[];
  // function name → neighbouring function names (callers ∪ callees)
  neighbors: Map<string, Set<string>>;
}

export interface QueryProfile {
  raw: string;
  tokens: Set<string>;
  concepts: Set<string>;
  subjectTokens: Set<string>;
}

const UNIT_TEXT_MAX = 2000;
const EXCERPT_FACT_MAX = 40;

function factText(fact: TwinSourceFactInput): string {
  return typeof fact.text === "string" ? fact.text.trim() : "";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

// Extract the lexical, semantic, and subject profile of a piece of text.
// Mirrors parseClaim's decomposition but is reusable for reports, agent
// retrieval queries, and repository units.
export function profileFor(text: string): QueryProfile {
  const lower = typeof text === "string" ? text.toLowerCase() : "";
  const tokens = new Set(contentTokens(lower));
  const concepts = conceptsFor(lower);
  const subjectTokens = new Set<string>();
  for (const t of tokens) {
    if (conceptsFor(t).size > 0) continue;
    subjectTokens.add(t);
  }
  return { raw: text, tokens, concepts, subjectTokens };
}

function unitTokenSet(unit: RetrievalUnit): Set<string> {
  const source = [unit.function ?? "", unit.file, unit.testScenario ?? "", unit.text]
    .join(" ")
    .toLowerCase();
  return new Set(contentTokens(source));
}

function factsForFunction(
  fn: TwinFunctionInput,
  fileFacts: TwinSourceFactInput[]
): TwinSourceFactInput[] {
  if (
    typeof fn.line === "number" &&
    typeof fn.endLine === "number" &&
    fn.endLine >= fn.line
  ) {
    return fileFacts.filter(
      (f) => typeof f.line === "number" && f.line >= fn.line! && f.line <= fn.endLine!
    );
  }
  const nameTokens = splitIdentifier(fn.name ?? "");
  const byName = fileFacts.filter((f) => {
    const t = factText(f).toLowerCase();
    return nameTokens.some((n) => t.includes(n));
  });
  return byName.length > 0 ? byName : fileFacts;
}

function bounded(text: string): string {
  return text.length > UNIT_TEXT_MAX ? text.slice(0, UNIT_TEXT_MAX) : text;
}

// Build the hybrid retrieval index for one analyzed job. Deterministic and
// pure: no model, no I/O, no side effects.
export function buildRetrievalIndex(input: RetrievalIndexInput): RetrievalIndex {
  const provenance: EvidenceProvenance = {
    jobId: input.jobId,
    repository: input.repository,
    ref: input.ref ?? null,
    commitSha: input.commitSha ?? null,
  };
  const functions = Array.isArray(input.functions) ? input.functions : [];
  const tests = Array.isArray(input.tests) ? input.tests : [];
  const relationships = Array.isArray(input.relationships) ? input.relationships : [];
  const sourceFacts = Array.isArray(input.sourceFacts) ? input.sourceFacts : [];

  // Graph adjacency across all functions.
  const neighbors = new Map<string, Set<string>>();
  const addNeighbor = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    const set = neighbors.get(a) ?? new Set<string>();
    set.add(b);
    neighbors.set(a, set);
  };
  for (const r of relationships) {
    if (r.type !== "CALLS") continue;
    const from = typeof r.caller === "string" && r.caller ? r.caller : r.from;
    const to = typeof r.to === "string" ? r.to : "";
    if (!from || !to) continue;
    // Resolve dotted callees to their bare name so createOrder → getCartTotal
    // links to the definition, not the call site.
    addNeighbor(from, to.split(".").pop() ?? to);
    addNeighbor(to.split(".").pop() ?? to, from);
  }

  const factsByPath = new Map<string, TwinSourceFactInput[]>();
  for (const f of sourceFacts) {
    if (typeof f.path !== "string") continue;
    const list = factsByPath.get(f.path) ?? [];
    list.push(f);
    factsByPath.set(f.path, list);
  }

  const testPaths = new Set<string>();
  for (const t of tests) {
    const p = typeof t.path === "string" && t.path.length > 0 ? t.path : t.file;
    if (typeof p === "string" && p.length > 0) testPaths.add(p);
  }
  const scenarios = reconstructScenarios(sourceFacts, testPaths);

  const units: RetrievalUnit[] = [];

  // SOURCE units: one per function, with a bounded excerpt of the function's
  // own facts (line range when known).
  for (const fn of functions) {
    const path = typeof fn.path === "string" ? fn.path : "(unknown)";
    const fileFacts = factsByPath.get(path) ?? [];
    const attributed = factsForFunction(fn, fileFacts).slice(0, EXCERPT_FACT_MAX);
    const text = bounded(
      attributed.map((f) => factText(f)).filter(Boolean).join("\n")
    );
    units.push({
      id: `source:${path}:${fn.name ?? "(anonymous)"}:${fn.line ?? 0}`,
      sourceType: "source",
      file: path,
      line: typeof fn.line === "number" ? fn.line : 1,
      endLine: typeof fn.endLine === "number" ? fn.endLine : null,
      function: typeof fn.name === "string" ? fn.name : null,
      testScenario: null,
      assertions: [],
      text,
      provenance,
    });
  }

  // TEST units: one per reconstructed scenario, with its assertions.
  for (const s of scenarios) {
    const facts = s.facts.map(factText).filter(Boolean);
    const assertions = facts.filter((t) => /\bexpect\s*\(|\bthrow\b|toThrow/.test(t));
    units.push({
      id: `test:${s.file}#${s.description}`,
      sourceType: "test",
      file: s.file,
      line: typeof s.facts[0]?.line === "number" ? s.facts[0]!.line! : 1,
      endLine: null,
      function: null,
      testScenario: s.description,
      assertions,
      text: bounded([s.description, ...facts].join("\n")),
      provenance,
    });
  }

  // GRAPH units: one per function with recorded callers/callees, so proximity
  // is retrievable as evidence rather than only a scoring hint.
  for (const fn of functions) {
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    const rel = neighbors.get(name);
    if (!rel || rel.size === 0) continue;
    units.push({
      id: `graph:${name}`,
      sourceType: "graph",
      file: typeof fn.path === "string" ? fn.path : "(unknown)",
      line: typeof fn.line === "number" ? fn.line : 1,
      endLine: null,
      function: name,
      testScenario: null,
      assertions: [],
      text: `callers/callees: ${[...rel].slice(0, 12).join(", ")}`,
      provenance,
    });
  }

  // METADATA unit: package manager / test framework / scripts.
  const scriptEntries = Object.entries(input.scripts ?? {});
  units.push({
    id: "metadata:repository",
    sourceType: "metadata",
    file: "package.json",
    line: 1,
    endLine: null,
    function: null,
    testScenario: null,
    assertions: [],
    text: bounded(
      [
        `repository: ${input.repository}`,
        `packageManager: ${input.packageManager ?? "unknown"}`,
        ...scriptEntries.slice(0, 12).map(([k, v]) => `script ${k}: ${v}`),
      ].join("\n")
    ),
    provenance,
  });

  // GIT units: recent relevant commits, only when supplied by the caller.
  for (const c of input.recentCommits ?? []) {
    units.push({
      id: `git:${c.sha}`,
      sourceType: "git",
      file: "(history)",
      line: 1,
      endLine: null,
      function: null,
      testScenario: null,
      assertions: [],
      text: bounded(`${c.sha.slice(0, 12)} ${c.subject}${c.date ? ` (${c.date})` : ""}`),
      provenance,
    });
  }

  return { provenance, units, scenarios, functions, neighbors };
}

export interface RetrievalSignals {
  lexical: number;
  semantic: number;
  name: number;
  path: number;
  scenario: number;
  assertion: number;
  graph: number;
  location: number;
  subject: number;
}

export interface ScoredEvidence {
  unit: RetrievalUnit;
  score: number;
  signals: RetrievalSignals;
}

export interface RetrieveOptions {
  // Isolation guard: when set, units from another job are dropped before
  // scoring. Callers always pass the job the index was built for.
  jobId?: string;
  limit?: number;
  // The function the agent currently believes is the target. Enables the
  // scenario/assertion/graph boosts that keep a vocabulary-only match from
  // outranking the function the relevant test actually exercises.
  targetName?: string | null;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) for (const y of b) if (tokensMatch(x, y)) n++;
  return n;
}

// Hybrid score for one unit against one query profile. Every signal is
// bounded; no single signal can dominate except scenario linkage, which is
// the strongest indicator that a test actually exercises the behavior.
export function scoreUnit(
  unit: RetrievalUnit,
  query: QueryProfile,
  opts: { targetName?: string | null; neighbors?: Map<string, Set<string>> } = {}
): ScoredEvidence {
  const unitTokens = unitTokenSet(unit);
  const unitConcepts = conceptsFor([unit.function ?? "", unit.file, unit.testScenario ?? "", unit.text].join(" "));
  const targetName = opts.targetName ?? null;

  const lexical = overlapCount(query.tokens, unitTokens);
  const semantic = overlapCount(query.concepts, unitConcepts) * 2;

  const functionName = unit.function ?? "";
  const nameTokens = new Set(splitIdentifier(functionName));
  const name =
    nameTokens.size > 0
      ? overlapCount(query.subjectTokens, nameTokens) * 4 + overlapCount(query.tokens, nameTokens) * 2
      : 0;

  const pathTokens = new Set(splitIdentifier(unit.file));
  const path = overlapCount(query.subjectTokens, pathTokens) * 1;

  let scenario = 0;
  if (unit.testScenario) {
    const descriptionTokens = new Set(contentTokens(unit.testScenario));
    scenario += overlapCount(query.tokens, descriptionTokens) * 2;
    if (targetName && (unit.text.includes(targetName) || unit.assertions.some((a) => a.includes(targetName)))) {
      scenario += 4;
    }
  }

  let assertion = 0;
  for (const a of unit.assertions) {
    const tokens = new Set(contentTokens(a));
    assertion += overlapCount(query.tokens, tokens);
  }

  let graph = 0;
  if (targetName && functionName && opts.neighbors) {
    if (opts.neighbors.get(targetName)?.has(functionName)) graph += 2;
  }

  const subject = overlapCount(query.subjectTokens, unitTokens) * 1;

  // Location is a pure deterministic tie-break: earlier source lines win. It
  // only applies once a substantive signal fired, so an unsupported report
  // cannot retrieve every source unit on its line number alone.
  const substantive = lexical + semantic + name + path + scenario + assertion + graph + subject;
  const location =
    substantive > 0 && unit.sourceType === "source" ? Math.max(0, 3 - unit.line / 1000) : 0;

  const score = substantive + location;
  return {
    unit,
    score,
    signals: { lexical, semantic, name, path, scenario, assertion, graph, location, subject },
  };
}

// Rank units for a query (or several). Returns scored units, best first.
// Isolation is enforced here: when opts.jobId is set, a unit whose provenance
// belongs to another job is skipped entirely.
export function retrieveEvidence(
  index: RetrievalIndex,
  queries: string | string[],
  opts: RetrieveOptions = {}
): ScoredEvidence[] {
  const list = Array.isArray(queries) ? queries : [queries];
  const profiles = list.map(profileFor).filter((p) => p.tokens.size > 0 || p.concepts.size > 0);
  if (profiles.length === 0) return [];
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
  const scored: ScoredEvidence[] = [];
  for (const unit of index.units) {
    if (opts.jobId && unit.provenance.jobId !== opts.jobId) continue;
    let best: ScoredEvidence | null = null;
    for (const p of profiles) {
      const s = scoreUnit(unit, p, { targetName: opts.targetName, neighbors: index.neighbors });
      if (!best || s.score > best.score) best = s;
    }
    if (best && best.score > 0) scored.push(best);
  }
  // Deterministic, principled ordering: total score first; on a tie prefer
  // the unit whose scenario description / assertions match the report more
  // strongly (a name that describes the behavior is a stronger signal than
  // incidental body-token overlap), then id for stability. Never let an
  // arbitrary id decide which sibling scenario governs the contract.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.signals.scenario - a.signals.scenario ||
      b.signals.assertion - a.signals.assertion ||
      a.unit.id.localeCompare(b.unit.id)
  );
  return scored.slice(0, limit);
}

// Convert a retrieval unit into the evidence contract. The model may cite an
// id; this is the only transformation that turns a citation into evidence.
export function toEvidence(unit: RetrievalUnit): Evidence {
  return {
    sourceType: unit.sourceType,
    file: unit.file,
    line: unit.line,
    function: unit.function,
    text: unit.text,
    provenance: {
      jobId: unit.provenance.jobId,
      repository: unit.provenance.repository,
      ref: unit.provenance.ref,
      commitSha: unit.provenance.commitSha,
    },
  };
}

// Compact, bounded rendering of evidence for a model prompt. Never the whole
// repository — only the retrieved units, each with its provenance.
export function renderEvidenceForPrompt(scored: ScoredEvidence[], maxChars = 12000): string {
  const lines: string[] = [];
  let used = 0;
  for (const s of scored) {
    const u = s.unit;
    const header = `[${u.id}] (${u.sourceType}) ${u.file}:${u.line}${u.function ? ` · ${u.function}` : ""}${u.testScenario ? ` · "${u.testScenario}"` : ""}`;
    const body = u.text.replace(/\s+\n/g, "\n").slice(0, 600);
    const block = `${header}\n${body}`;
    if (used + block.length > maxChars) break;
    used += block.length;
    lines.push(block);
  }
  return lines.join("\n\n");
}
