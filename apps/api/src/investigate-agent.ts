// LLM-assisted investigation agent (Phase RAG), deterministically validated.
//
// Pipeline:
//   USER REPORT
//     → NEMOTRON INVESTIGATION AGENT      (interpret, decompose, query)
//     → RAG RETRIEVAL FROM CODETWIN       (retrieval.ts, hybrid + provenance)
//     → HYPOTHESIS / EVIDENCE SYNTHESIS   (model selects cited evidence)
//     → DETERMINISTIC EVIDENCE VALIDATION (investigateTwin + citation checks)
//     → INVESTIGATION RUN                 (state + evidence + contract)
//     → USER REVIEW                       (READY_FOR_REVIEW → confirm)
//     → FORGE
//
// The model never decides READY and never manufactures evidence. Every
// evidence unit it may cite comes from the retrieval index; citations that do
// not resolve are dropped. The deterministic investigator owns target
// validity, scenario validity, source/test provenance, ambiguity detection,
// the READY/AMBIGUOUS/NO_MATCH verdict, and repair-contract safety. When no
// model is configured, the agent degrades to the deterministic path exactly
// as before.

import { createHash } from "node:crypto";
import {
  buildInvestigationSynthesisPrompt,
  buildInvestigationUnderstandingPrompt,
  chatComplete,
  INVESTIGATION_AGENT_SYSTEM,
  parseAgentSynthesis,
  parseAgentUnderstanding,
  type AgentSynthesis,
  type AgentUnderstanding,
  type LlmConfig,
} from "@hubris/llm";
import {
  buildPlanFromEvidence,
  scenarioReferencesTarget,
  type InvestigationResult,
  type InvestigateInput,
  type TestScenario,
  type TwinFunctionInput,
} from "./investigate";
import {
  buildRetrievalIndex,
  renderEvidenceForPrompt,
  retrieveEvidence,
  toEvidence,
  type Evidence,
  type RetrievalIndex,
  type ScoredEvidence,
} from "./retrieval";

export type InvestigationState =
  | "DRAFT"
  | "RETRIEVING"
  | "ANALYZING"
  | "CLARIFICATION_NEEDED"
  | "READY_FOR_REVIEW"
  | "READY"
  | "AMBIGUOUS"
  | "NO_MATCH";

export interface InvestigationProvenance {
  jobId: string;
  repository: string;
  ref: string | null;
  commitSha: string | null;
}

// One viable interpretation of the report: an existing test scenario and the
// repository function it exercises. Options come ONLY from retrieved
// repository evidence, and carry a stable id derived from that evidence, so a
// selection can be validated against the exact question that offered it.
export interface ClarificationOption {
  id: string;
  label: string;
  file: string;
  scenario: string;
  function: string;
  functionFile: string;
}

export interface InvestigationClarification {
  // Stable for (option set, report): identifies exactly which question a
  // selection answers.
  questionId: string;
  // Stable for the option set alone: used to detect an equivalent question
  // being asked again without progress.
  optionSetKey: string;
  question: string;
  options: ClarificationOption[];
}

// The user's validated answer to a prior clarification. The option is resolved
// server-side from the persisted prior question — never trusted from the client.
export interface ClarificationSelection {
  questionId: string;
  optionId: string;
  option: ClarificationOption;
}

// A specific, actionable reason no repair contract could be established and
// no answer from the user can fix it by choosing among options.
export interface BlockedInfo {
  code: string;
  reason: string;
  nextStep: string;
}

export interface AgentInvestigation {
  state: InvestigationState;
  // Deterministic verdict: drives READY/AMBIGUOUS/NO_MATCH and the plan.
  deterministic: InvestigationResult;
  observedBehavior: string;
  expectedBehavior: string;
  modelSummary: string;
  clarification: InvestigationClarification | null;
  // Set instead of a clarification when more questions cannot help.
  blocked: BlockedInfo | null;
  // Answers applied to this run, oldest first (carried across retries).
  selections: ClarificationSelection[];
  // Option-set keys already asked in this conversation (loop guard).
  askedOptionSets: string[];
  // Evidence actually retrieved for this run (the cluster), in the evidence
  // contract shape. Model-cited ids that did not resolve are dropped.
  retrievedEvidence: Evidence[];
  selectedEvidenceIds: string[];
  relevantScenarios: string[];
  relevantSourceFacts: string[];
  relevantAssertions: string[];
  provenance: InvestigationProvenance;
  modelUsed: boolean;
}

export interface RunInvestigationAgentInput {
  llm: LlmConfig | null;
  jobId: string;
  repository: string;
  ref?: string | null;
  commitSha?: string | null;
  scripts?: Record<string, string>;
  packageManager?: string | null;
  report: string;
  functions: InvestigateInput["functions"];
  tests: InvestigateInput["tests"];
  relationships: InvestigateInput["relationships"];
  sourceFacts?: InvestigateInput["sourceFacts"];
  // Free-text hint (legacy): feeds the model prompts and retrieval queries only.
  clarification?: { priorQuestion: string; answer: string };
  // Validated, structured answers to earlier clarification questions. Unlike
  // the free-text hint these are authoritative: the selected scenario/target
  // is pinned into the evidence the contract is built from.
  selections?: ClarificationSelection[];
  // Option-set keys already asked in this conversation.
  askedOptionSets?: string[];
  signal?: AbortSignal;
}

const RETRIEVAL_LIMIT = 16;
const SYNTHESIS_EVIDENCE_CHARS = 12000;
const MODEL_TIMEOUT_MS = 60000;

function emptyUnderstanding(): AgentUnderstanding {
  return {
    observedBehavior: "",
    expectedBehavior: "",
    entities: [],
    actions: [],
    ambiguities: [],
    queries: [],
  };
}

function buildIndexFromInput(input: RunInvestigationAgentInput): RetrievalIndex {
  return buildRetrievalIndex({
    jobId: input.jobId,
    repository: input.repository,
    ref: input.ref ?? null,
    commitSha: input.commitSha ?? null,
    functions: input.functions,
    tests: input.tests,
    relationships: input.relationships,
    sourceFacts: input.sourceFacts ?? [],
    scripts: input.scripts,
    packageManager: input.packageManager,
  });
}

async function understandReport(
  llm: LlmConfig,
  input: RunInvestigationAgentInput
): Promise<AgentUnderstanding | null> {
  try {
    const text = await chatComplete(
      llm,
      [
        { role: "system", content: INVESTIGATION_AGENT_SYSTEM },
        {
          role: "user",
          content: buildInvestigationUnderstandingPrompt({
            repoName: input.repository,
            report: input.report,
            evidence: "",
            priorQuestion: input.clarification?.priorQuestion,
            clarification: input.clarification?.answer,
          }),
        },
      ],
      { responseFormat: "json_object", signal: input.signal ?? AbortSignal.timeout(MODEL_TIMEOUT_MS) }
    );
    return parseAgentUnderstanding(text);
  } catch {
    // Any model failure degrades to the deterministic path; never abort.
    return null;
  }
}

async function synthesizeHypothesis(
  llm: LlmConfig,
  input: RunInvestigationAgentInput,
  retrieved: ScoredEvidence[]
): Promise<AgentSynthesis | null> {
  try {
    const text = await chatComplete(
      llm,
      [
        { role: "system", content: INVESTIGATION_AGENT_SYSTEM },
        {
          role: "user",
          content: buildInvestigationSynthesisPrompt({
            repoName: input.repository,
            report: input.report,
            evidence: renderEvidenceForPrompt(retrieved, SYNTHESIS_EVIDENCE_CHARS),
            priorQuestion: input.clarification?.priorQuestion,
            clarification: input.clarification?.answer,
          }),
        },
      ],
      { responseFormat: "json_object", signal: input.signal ?? AbortSignal.timeout(MODEL_TIMEOUT_MS) }
    );
    return parseAgentSynthesis(text);
  } catch {
    return null;
  }
}

// Keep only citations that resolve to a real retrieved unit. A model id that
// is not in the index is discarded — the model can never inject evidence.
function resolveSelectedEvidence(
  index: RetrievalIndex,
  ids: string[]
): { units: ScoredEvidence[]; selectedIds: string[] } {
  const byId = new Map(index.units.map((u) => [u.id, u]));
  const units: ScoredEvidence[] = [];
  const selectedIds: string[] = [];
  for (const id of ids) {
    const unit = byId.get(id);
    if (!unit) continue;
    selectedIds.push(id);
    units.push({ unit, score: 0, signals: ZERO_SIGNALS });
  }
  return { units, selectedIds };
}

const ZERO_SIGNALS = {
  lexical: 0,
  semantic: 0,
  name: 0,
  path: 0,
  scenario: 0,
  assertion: 0,
  graph: 0,
  location: 0,
  subject: 0,
};

const MAX_CLARIFICATION_OPTIONS = 4;

function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

export function normalizeReport(report: string): string {
  return report.replace(/\s+/g, " ").trim().toLowerCase();
}

export function optionSetKeyOf(options: ClarificationOption[]): string {
  return shortHash(...options.map((o) => o.id).sort());
}

export function questionIdFor(optionSetKey: string, report: string): string {
  return `q_${shortHash(optionSetKey, normalizeReport(report))}`;
}

// The repository function a test scenario is about: what it asserts on first,
// otherwise what it calls. Only functions that exist in the twin count.
function scenarioFunction(scenario: TestScenario, known: Set<string>): string | null {
  for (const name of scenario.asserted) if (known.has(name)) return name;
  for (const name of scenario.called) if (known.has(name)) return name;
  return null;
}

// Clarification choices are existing test scenarios from the retrieved
// evidence — facts the user can recognise ("which of these tests describes the
// behavior you mean?") instead of questions about implementation details.
// Stable ids derive from (file, scenario, function), so the same repository
// evidence always yields the same ids.
function buildClarificationOptions(
  index: RetrievalIndex,
  retrieved: ScoredEvidence[],
  functions: TwinFunctionInput[],
  known: Set<string>
): ClarificationOption[] {
  const options: ClarificationOption[] = [];
  const seen = new Set<string>();
  for (const s of retrieved) {
    if (s.unit.sourceType !== "test" || !s.unit.testScenario) continue;
    const scenario = index.scenarios.find(
      (sc) => sc.file === s.unit.file && sc.description === s.unit.testScenario
    );
    if (!scenario || seen.has(scenario.id)) continue;
    const fnName = scenarioFunction(scenario, known);
    if (!fnName) continue;
    seen.add(scenario.id);
    const fn = functions.find((f) => f.name === fnName);
    options.push({
      id: `opt_${shortHash(scenario.file, scenario.description, fnName)}`,
      label: `"${scenario.description}" (${scenario.file}) — exercises ${fnName}()`,
      file: scenario.file,
      scenario: scenario.description,
      function: fnName,
      functionFile: fn?.path ?? "",
    });
    if (options.length >= MAX_CLARIFICATION_OPTIONS) break;
  }
  return options;
}

const CLARIFICATION_QUESTION =
  "Several existing tests could describe this report. Which one matches the behavior you mean?";

// Turn a deterministic evidence gap into a specific, actionable blocked state.
function describeBlock(code: string, message: string, afterSelection: boolean): BlockedInfo {
  const nextStepByCode: Record<string, string> = {
    CONTRADICTORY_REPORT:
      "State the expected behavior once, without requiring and rejecting the same outcome.",
    NO_TEST_SCENARIO:
      "No existing test exercises the target. Name the function and the test file that covers it, or add a failing test that reproduces the report.",
    SCENARIO_DOES_NOT_EXERCISE_TARGET:
      "Name the function and the test that exercises it, or add a test that does.",
    SCENARIO_ASSERTS_NOTHING:
      "The matching test does not assert the expected outcome. Name a test that does, or state the expected result (for example the exact error text).",
    CONTRACT_NOT_GROUNDED:
      "The repository source does not show a condition and an operation to change for this test. Name the function whose behavior is wrong.",
    TARGET_UNRESOLVED:
      "No repository function matches the report. Name the function or file involved.",
    EVIDENCE_UNRESOLVED:
      "The selected evidence could not be resolved against the repository. Refine the report and investigate again.",
    REPEATED_QUESTION:
      "This question was already asked and the answer did not establish a repair contract. Add the missing detail (the function or test involved) to the description and investigate again.",
    STALE_SELECTION:
      "The earlier selection no longer matches the repository evidence. Investigate again.",
  };
  const nextStep =
    nextStepByCode[code] ?? "Add the function or test involved to the description and investigate again.";
  return {
    code,
    reason: afterSelection ? `Your selection was applied, but ${message.charAt(0).toLowerCase()}${message.slice(1)}` : message,
    nextStep,
  };
}

// Run the agent. Deterministic and safe: a null/absent model, a model error,
// or a malformed model response all degrade to the deterministic investigator
// over the exact same twin.
export async function runInvestigationAgent(
  input: RunInvestigationAgentInput
): Promise<AgentInvestigation> {
  const provenance: InvestigationProvenance = {
    jobId: input.jobId,
    repository: input.repository,
    ref: input.ref ?? null,
    commitSha: input.commitSha ?? null,
  };
  const index = buildIndexFromInput(input);

  // Phase 1 — interpret the report (best effort, model-assisted).
  const understanding = input.llm ? await understandReport(input.llm, input) : null;
  const queries = [
    input.report,
    ...(understanding?.queries ?? []),
    ...(understanding?.entities ?? []),
    ...(understanding?.actions ?? []),
    ...(input.clarification?.answer ? [input.clarification.answer] : []),
  ].filter((q) => typeof q === "string" && q.trim().length > 0);

  // Phase 2 — hybrid retrieval over the CodeTwin, scoped to this job.
  let retrieved = retrieveEvidence(index, queries, {
    jobId: input.jobId,
    limit: RETRIEVAL_LIMIT,
  });

  // Phase 3 — synthesis: the model selects among retrieved evidence.
  const synthesis = input.llm ? await synthesizeHypothesis(input.llm, input, retrieved) : null;
  const resolved = synthesis
    ? resolveSelectedEvidence(index, synthesis.selectedEvidence)
    : { units: [], selectedIds: [] };
  // Surface selected units first in the evidence list (still bounded).
  if (resolved.units.length > 0) {
    const selectedIdSet = new Set(resolved.selectedIds);
    retrieved = [...resolved.units, ...retrieved.filter((s) => !selectedIdSet.has(s.unit.id))].slice(
      0,
      RETRIEVAL_LIMIT
    );
  }

  // A validated answer to an earlier clarification is authoritative: the
  // selected scenario and the function it exercises are pinned to the front of
  // the evidence the contract is built from. The answer is never merely a hint
  // that a later model call may ignore or a retry may drop.
  const selections = input.selections ?? [];
  const pinnedOption = selections.length > 0 ? selections[selections.length - 1].option : null;
  const pinnedScenario = pinnedOption
    ? index.scenarios.find((sc) => sc.file === pinnedOption.file && sc.description === pinnedOption.scenario)
    : undefined;
  const staleSelection = pinnedOption !== null && !pinnedScenario;
  if (pinnedOption && pinnedScenario) {
    const pinnedTest = index.units.find(
      (u) => u.sourceType === "test" && u.file === pinnedScenario.file && u.testScenario === pinnedScenario.description
    );
    const pinnedSource = index.units.find(
      (u) =>
        u.sourceType === "source" &&
        u.function === pinnedOption.function &&
        (pinnedOption.functionFile ? u.file === pinnedOption.functionFile : true)
    );
    const pinnedUnits: ScoredEvidence[] = [pinnedSource, pinnedTest]
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((unit) => ({ unit, score: 0, signals: ZERO_SIGNALS }));
    const pinnedIds = new Set(pinnedUnits.map((u) => u.unit.id));
    retrieved = [...pinnedUnits, ...retrieved.filter((s) => !pinnedIds.has(s.unit.id))];
  }

  // Phase 4 — authoritative selection → deterministic validation/extraction.
  // The selection layer decides WHICH repository evidence is in play: the
  // model's cited units when it selected any, otherwise the RAG ranking. The
  // deterministic layer only validates and extracts from that evidence — it
  // never re-runs a repository-wide investigation.
  // The selected evidence is authoritative: the model's cited units (when any
  // resolved) followed by the RAG ranking. The deterministic layer reads this
  // order; it does not re-rank or substitute.
  const selected = retrieved;
  const resolutionFailure =
    synthesis !== null && synthesis.selectedEvidence.length > 0 && resolved.units.length === 0;

  const knownFunctions = new Set(
    input.functions.map((f) => (typeof f.name === "string" ? f.name : "")).filter(Boolean)
  );

  // Target: prefer the function exercised by the FIRST selected test scenario
  // (asserted/called linkage), then the first selected source unit. Resolving a
  // linked target is selection support, not a fresh repository-wide search.
  const topTestUnit = selected.find((s) => s.unit.sourceType === "test" && s.unit.testScenario);
  const topScenario = topTestUnit
    ? index.scenarios.find(
        (sc) => sc.file === topTestUnit.unit.file && sc.description === topTestUnit.unit.testScenario
      )
    : undefined;
  const linkedNames = topScenario ? [...topScenario.asserted, ...topScenario.called] : [];
  const sourceUnits = selected.filter((s) => s.unit.sourceType === "source" && s.unit.function);
  const targetUnit =
    sourceUnits.find((s) => linkedNames.includes(s.unit.function ?? "")) ?? sourceUnits[0];
  const target: TwinFunctionInput | undefined = targetUnit
    ? input.functions.find(
        (f) => f.name === targetUnit.unit.function && (f.path ?? "") === targetUnit.unit.file
      ) ?? input.functions.find((f) => f.name === targetUnit.unit.function)
    : undefined;
  const targetName = target?.name ?? "";

  // Scenarios: selected TEST units, in selection order, that exercise the
  // target. Sibling scenarios that do not reference the target are dropped.
  const selectedScenarios: TestScenario[] = [];
  const seenScenario = new Set<string>();
  for (const s of selected) {
    if (s.unit.sourceType !== "test" || !s.unit.testScenario) continue;
    const scenario = index.scenarios.find(
      (sc) => sc.file === s.unit.file && sc.description === s.unit.testScenario
    );
    if (!scenario || seenScenario.has(scenario.id)) continue;
    if (!scenarioReferencesTarget(scenario, targetName)) continue;
    seenScenario.add(scenario.id);
    selectedScenarios.push(scenario);
  }
  // Only the SELECTED (primary) scenario grounds the contract. Siblings never
  // enter it, even when they are highly relevant.
  const contractScenarios = selectedScenarios.slice(0, 1);
  // The persisted evidence chain is exactly what drove the contract: the
  // selected target's source unit, the primary scenario unit, and any units
  // the model explicitly selected. Never the raw retrieval ranking.
  const primaryScenario = contractScenarios[0];
  const primaryUnit = primaryScenario
    ? selected.find(
        (s) =>
          s.unit.sourceType === "test" &&
          s.unit.file === primaryScenario.file &&
          s.unit.testScenario === primaryScenario.description
      )
    : undefined;
  const usedUnits: ScoredEvidence[] = [];
  for (const unit of [targetUnit, primaryUnit, ...resolved.units]) {
    if (unit && !usedUnits.some((u) => u.unit.id === unit.unit.id)) usedUnits.push(unit);
  }

  // Scope the contract's source facts to the SELECTED source functions (the
  // target plus any selected helper). The builder never widens this scope.
  const selectedFunctionNames = new Set<string>();
  if (target?.name) selectedFunctionNames.add(target.name);
  for (const u of usedUnits) {
    if (u.unit.sourceType === "source" && u.unit.function) {
      selectedFunctionNames.add(u.unit.function);
    }
  }
  // Include the target's directly-called helper functions (bounded, one hop).
  // These are part of the target's causal chain, not an unrelated search.
  if (target?.name) {
    for (const r of input.relationships ?? []) {
      if (r.type !== "CALLS") continue;
      if ((r.caller ?? r.from) !== target.name) continue;
      const callee = (r.to ?? "").split(".").pop() ?? "";
      if (callee && knownFunctions.has(callee)) selectedFunctionNames.add(callee);
    }
  }
  const selectedFunctions = input.functions.filter(
    (f) => typeof f.name === "string" && selectedFunctionNames.has(f.name)
  );
  const scopedSourceFacts = (input.sourceFacts ?? []).filter((fact) =>
    selectedFunctions.some(
      (fn) =>
        typeof fn.path === "string" &&
        fact.path === fn.path &&
        fact.kind !== "test" &&
        typeof fact.line === "number" &&
        typeof fn.line === "number" &&
        fact.line >= fn.line &&
        fact.line <= (typeof fn.endLine === "number" ? fn.endLine : fn.line)
    )
  );

  let deterministic: InvestigationResult;
  if (selected.length === 0) {
    deterministic = {
      status: "NO_MATCH",
      plan: null,
      message: `No repository evidence connects to "${input.report.slice(0, 160)}".`,
    };
  } else if (staleSelection) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message: "The scenario you selected is no longer present in the repository evidence.",
      code: "EVIDENCE_UNRESOLVED",
    };
  } else if (resolutionFailure) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message:
        "The selected evidence could not be resolved to repository evidence. Refine the report or run a new investigation.",
      code: "EVIDENCE_UNRESOLVED",
    };
  } else if (!target) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message: "The selected repository evidence does not identify a target function for this report.",
      code: "TARGET_UNRESOLVED",
    };
  } else if (selectedScenarios.length === 0) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message: `The selected evidence does not include a test scenario exercising "${targetName}".`,
      code: "NO_TEST_SCENARIO",
    };
  } else {
    deterministic = buildPlanFromEvidence({
      focus: input.report,
      target,
      scenarios: contractScenarios,
      sourceFacts: scopedSourceFacts,
      knownFunctions,
      functions: input.functions,
      selectedFunctionNames,
      gap: 2,
    });
  }

  const plan = deterministic.status === "READY" ? deterministic.plan : null;
  // The evidence view is the AUTHORITATIVE used chain, never the raw retrieval
  // ranking, so review cannot show a scenario the contract did not use.
  const relevantScenarios = contractScenarios.map((s) => `${s.description} (${s.file})`);
  const relevantSourceFacts = scopedSourceFacts.slice(0, 6).map((f) => `${f.path}:${f.line}`);
  const relevantAssertions = plan ? plan.repairContract.relevantAssertions.slice(0, 6) : [];

  const observedBehavior =
    understanding?.observedBehavior ||
    plan?.currentBehavior ||
    `User report: ${input.report.slice(0, 160)}`;
  const expectedBehavior =
    plan?.expectedBehavior ||
    understanding?.expectedBehavior ||
    "";
  const modelSummary =
    synthesis?.hypothesis?.trim() ||
    (understanding
      ? `Report describes ${understanding.observedBehavior || "an issue"}; expected ${understanding.expectedBehavior || "different behavior"}.`
      : "");

  // Phase 5 — map to the state model.
  let state: InvestigationState;
  let clarification: InvestigationClarification | null = null;
  let blocked: BlockedInfo | null = null;
  const askedOptionSets = input.askedOptionSets ?? [];
  if (deterministic.status === "NO_MATCH") {
    state = "NO_MATCH";
  } else if (deterministic.status === "READY") {
    state = "READY_FOR_REVIEW";
  } else {
    // Deterministic ambiguity. Ask only when materially different, evidence-
    // grounded interpretations remain — and never twice for the same question.
    // Everything else is a specific blocked state: more questions cannot add
    // repository evidence that is not there.
    const code = deterministic.status === "AMBIGUOUS" ? (deterministic.code ?? "CONTRACT_NOT_GROUNDED") : "CONTRACT_NOT_GROUNDED";
    const answered = selections.length > 0;
    const askable = !answered && code !== "CONTRADICTORY_REPORT" && code !== "EVIDENCE_UNRESOLVED";
    const options = askable
      ? buildClarificationOptions(index, retrieved, input.functions, knownFunctions)
      : [];
    const optionSetKey = options.length >= 2 ? optionSetKeyOf(options) : null;
    const repeated = optionSetKey !== null && askedOptionSets.includes(optionSetKey);
    if (optionSetKey !== null && !repeated) {
      clarification = {
        questionId: questionIdFor(optionSetKey, input.report),
        optionSetKey,
        question: CLARIFICATION_QUESTION,
        options,
      };
      state = "CLARIFICATION_NEEDED";
    } else {
      state = "AMBIGUOUS";
      blocked = describeBlock(repeated ? "REPEATED_QUESTION" : code, deterministic.message, answered);
    }
  }

  return {
    state,
    deterministic,
    observedBehavior,
    expectedBehavior,
    modelSummary,
    clarification,
    blocked,
    selections,
    askedOptionSets,
    retrievedEvidence: usedUnits.map((s) => toEvidence(s.unit)),
    selectedEvidenceIds: resolved.selectedIds,
    relevantScenarios,
    relevantSourceFacts,
    relevantAssertions,
    provenance,
    modelUsed: input.llm !== null && (understanding !== null || synthesis !== null),
  };
}

// Convenience for tests and callers: build evidence from an index directly.
export function evidenceFromIndex(index: RetrievalIndex, ids: string[]): Evidence[] {
  const byId = new Map(index.units.map((u) => [u.id, u]));
  return ids
    .map((id) => byId.get(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map(toEvidence);
}

// ---- clarification answer resolution (server-side validation) ----

export interface ClarificationAnswerRequest {
  priorInvestigationId?: string;
  answer: { questionId: string; optionId: string };
}

export type ClarificationAnswerResolution =
  | {
      ok: true;
      selections: ClarificationSelection[];
      askedOptionSets: string[];
      // What the new run persists about the answer it was built from.
      answer: { priorInvestigationId: string; questionId: string; optionId: string; label: string };
    }
  | { ok: false; code: string; error: string; status: 400 | 409 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asOption(v: unknown): ClarificationOption | null {
  if (!isRecord(v)) return null;
  const { id, label, file, scenario } = v;
  if (typeof id !== "string" || typeof label !== "string" || typeof file !== "string" || typeof scenario !== "string") {
    return null;
  }
  if (typeof v.function !== "string" || v.function.length === 0) return null;
  return {
    id,
    label,
    file,
    scenario,
    function: v.function,
    functionFile: typeof v.functionFile === "string" ? v.functionFile : "",
  };
}

function asSelection(v: unknown): ClarificationSelection | null {
  if (!isRecord(v)) return null;
  const option = asOption(v.option);
  if (!option || typeof v.questionId !== "string" || typeof v.optionId !== "string") return null;
  return { questionId: v.questionId, optionId: v.optionId, option };
}

// Validate a structured answer against the persisted prior run of THIS job.
// The option is resolved from the persisted question — a client can neither
// invent an option nor answer a question that is no longer current. Stale,
// already-answered, unknown, and report-changed answers are rejected.
export function resolveClarificationAnswer(
  priorRuns: unknown[],
  request: ClarificationAnswerRequest,
  report: string,
  jobId: string
): ClarificationAnswerResolution {
  const fail = (code: string, error: string, status: 400 | 409): ClarificationAnswerResolution => ({
    ok: false,
    code,
    error,
    status,
  });
  const priorId = request.priorInvestigationId?.trim();
  if (!priorId) {
    return fail("MISSING_PRIOR", "An answer must reference the investigation that asked the question.", 400);
  }
  const prior = priorRuns.find(
    (r): r is Record<string, unknown> =>
      isRecord(r) && r.investigationId === priorId && r.jobId === jobId
  );
  if (!prior) {
    return fail("PRIOR_NOT_FOUND", "The question this answer belongs to could not be found for this repository.", 409);
  }
  const clarification = isRecord(prior.clarification) ? prior.clarification : null;
  const options = clarification && Array.isArray(clarification.options)
    ? clarification.options.map(asOption).filter((o): o is ClarificationOption => o !== null)
    : [];
  if (!clarification || typeof clarification.questionId !== "string" || options.length === 0) {
    return fail("NO_OPEN_QUESTION", "That investigation did not ask a question.", 409);
  }
  if (clarification.questionId !== request.answer.questionId) {
    return fail("STALE_QUESTION", "This question is no longer current. Investigate again to get the current question.", 409);
  }
  if (normalizeReport(typeof prior.focus === "string" ? prior.focus : "") !== normalizeReport(report)) {
    return fail("REPORT_CHANGED", "The description changed after the question was asked. Investigate again with the new description.", 409);
  }
  const alreadyAnswered = priorRuns.some(
    (r) =>
      isRecord(r) &&
      isRecord(r.answer) &&
      r.answer.priorInvestigationId === priorId &&
      r.jobId === jobId
  );
  if (alreadyAnswered) {
    return fail("ALREADY_ANSWERED", "This question was already answered.", 409);
  }
  const option = options.find((o) => o.id === request.answer.optionId);
  if (!option) {
    return fail("INVALID_OPTION", "The selected option is not one of the choices offered for this question.", 400);
  }
  const priorSelections = Array.isArray(prior.selections)
    ? prior.selections.map(asSelection).filter((s): s is ClarificationSelection => s !== null)
    : [];
  const priorAsked = Array.isArray(prior.askedOptionSets)
    ? prior.askedOptionSets.filter((k): k is string => typeof k === "string")
    : [];
  const askedKey = typeof clarification.optionSetKey === "string" ? clarification.optionSetKey : optionSetKeyOf(options);
  return {
    ok: true,
    selections: [...priorSelections, { questionId: clarification.questionId, optionId: option.id, option }],
    askedOptionSets: priorAsked.includes(askedKey) ? priorAsked : [...priorAsked, askedKey],
    answer: {
      priorInvestigationId: priorId,
      questionId: clarification.questionId,
      optionId: option.id,
      label: option.label,
    },
  };
}
