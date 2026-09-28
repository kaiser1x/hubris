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

export interface InvestigationClarification {
  question: string;
  options: string[];
}

export interface AgentInvestigation {
  state: InvestigationState;
  // Deterministic verdict: drives READY/AMBIGUOUS/NO_MATCH and the plan.
  deterministic: InvestigationResult;
  observedBehavior: string;
  expectedBehavior: string;
  modelSummary: string;
  clarification: InvestigationClarification | null;
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
  clarification?: { priorQuestion: string; answer: string };
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
    units.push({ unit, score: 0, signals: { lexical: 0, semantic: 0, name: 0, path: 0, scenario: 0, assertion: 0, graph: 0, location: 0, subject: 0 } });
  }
  return { units, selectedIds };
}

function derivedClarificationOptions(index: RetrievalIndex, retrieved: ScoredEvidence[]): string[] {
  const options: string[] = [];
  for (const s of retrieved) {
    const label =
      s.unit.sourceType === "source" && s.unit.function
        ? `${s.unit.function}() in ${s.unit.file}`
        : s.unit.sourceType === "test" && s.unit.testScenario
          ? `the "${s.unit.testScenario}" behavior`
          : null;
    if (label && !options.includes(label)) options.push(label);
    if (options.length >= 5) break;
  }
  return options;
}

function fallbackClarificationQuestion(report: string): string {
  return `Which behavior is wrong in "${report.slice(0, 120)}"?`;
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
  } else if (resolutionFailure) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message:
        "The selected evidence could not be resolved to repository evidence. Refine the report or run a new investigation.",
    };
  } else if (!target) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message: "The selected repository evidence does not identify a target function for this report.",
    };
  } else if (selectedScenarios.length === 0) {
    deterministic = {
      status: "AMBIGUOUS",
      plan: null,
      message: `The selected evidence does not include a test scenario exercising "${targetName}".`,
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
  if (deterministic.status === "NO_MATCH") {
    state = "NO_MATCH";
  } else if (deterministic.status === "READY") {
    state = "READY_FOR_REVIEW";
  } else {
    // Deterministic ambiguity. A grounded clarification beats a dead end.
    const question = synthesis?.clarificationQuestion?.trim();
    const modelOptions = (synthesis?.clarificationOptions ?? []).filter(Boolean);
    const options = modelOptions.length > 0 ? modelOptions : derivedClarificationOptions(index, retrieved);
    if (question && options.length > 0) {
      clarification = { question, options: options.slice(0, 5) };
      state = "CLARIFICATION_NEEDED";
    } else if (options.length > 0) {
      clarification = {
        question: fallbackClarificationQuestion(input.report),
        options: options.slice(0, 5),
      };
      state = "CLARIFICATION_NEEDED";
    } else {
      state = "AMBIGUOUS";
    }
  }

  return {
    state,
    deterministic,
    observedBehavior,
    expectedBehavior,
    modelSummary,
    clarification,
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
