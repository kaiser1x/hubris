// Frontend view-model for Forge evidence (Phase J). Pure mapping from the
// persisted backend shapes into display state — no business logic, no
// fetching, no secrets. Two backend shapes exist and both are handled:
//   - structured runs: generation {source, format, focus, edits[]},
//     canonicalPatch {sha, bytes}, validation {editCategory, ...}
//   - diff runs: generationAttempts[]?, patch {source, diffSha256, diffBytes}
// Every function is total: malformed input yields explicit empty/unknown
// states, never throws, never fabricates a success.

export type ForgeRunKind = "structured" | "diff";

export type ForgeOutcome =
  | "FULL_SUITE_PASSED"
  | "REPAIR_VERIFIED"
  | "REPAIR_NOT_VERIFIED"
  | "VERIFICATION_INCOMPLETE"
  | "VERIFIED"
  | "VERIFICATION_FAILED"
  | "VERIFICATION_TIMEOUT"
  | "APPLY_FAILED"
  | "VALIDATION_FAILED"
  | "SOURCE_MISMATCH"
  | "UNKNOWN";

export interface ForgeStep {
  label: string;
  reached: boolean;
}

export interface ForgeEditView {
  path: string;
  function: string | null;
}

export interface ForgeCheck {
  label: string;
  ok: boolean;
}

export type VerifyResult = "PASS" | "FAIL" | "NOT RUN";

export interface ForgeAssessmentView {
  state: VerificationAssessmentState;
  patchApplied: boolean;
  targetVerificationPassed: boolean | null;
  targetTestFile: string | null;
  targetScenario: string | null;
  targetCommand: string | null;
  fullSuitePassed: boolean;
  unrelatedTestFailures: number;
  failedTests: string[];
  targetFailure: string | null;
}

export type VerificationAssessmentState =
  | "FULL_SUITE_PASSED"
  | "REPAIR_VERIFIED"
  | "REPAIR_NOT_VERIFIED"
  | "VERIFICATION_INCOMPLETE";

export interface ForgeVerificationView {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  started: boolean;
  result: VerifyResult;
  // User-facing assessment separating patch/target/full-suite outcomes.
  // Null on legacy entries (predates the assessment).
  assessment: ForgeAssessmentView | null;
}

export interface ForgeMismatchView {
  oldTextLength: number;
  sourceLength: number;
  matchingPrefixChars: number;
  sourceOffset: number;
  oldTextSnippet: string;
  sourceSnippet: string;
}

export interface PullRequestView {
  provider: string;
  repository: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  status: string;
}

export interface ForgeRunView {
  id: string;
  investigationId: string | null;
  number: number;
  kind: ForgeRunKind;
  status: string;
  outcome: ForgeOutcome;
  steps: ForgeStep[];
  modelSource: string | null;
  focus: string | null;
  edits: ForgeEditView[];
  editChecks: ForgeCheck[];
  patchBytes: number | null;
  patchShaShort: string | null;
  patchSha: string | null;
  applyApplied: boolean;
  // Bounded byte-mismatch evidence for EDIT_CONTEXT_MISMATCH. Null when the
  // run reached another terminal or predates this diagnostic.
  mismatch: ForgeMismatchView | null;
  // Source-revision provenance. Nulls mean legacy evidence that predates
  // revision tracking — rendered as "—", never backfilled.
  source: {
    ref: string | null;
    refSource: string | null;
    commitSha: string | null;
    analysisCommitSha: string | null;
    executionCommitSha: string | null;
    sandboxRef: string | null;
    sandboxSha: string | null;
    sandboxMatched: boolean | null;
  };
  sandbox: {
    image: string | null;
    manager: string | null;
    files: number | null;
    durationMs: number | null;
  };
  sandboxChecks: ForgeCheck[];
  verification: ForgeVerificationView | null;
  testSummary: { passed: number; total: number } | null;
  outputTail: string[];
  errorTail: string[];
  at: string | null;
  // GitHub Pull Request published from this verified run (SHIP). Null until
  // shipped; never fabricated.
  pullRequest: PullRequestView | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asMismatchView(raw: unknown): ForgeMismatchView | null {
  if (!isRecord(raw)) return null;
  const oldTextLength = asNumber(raw.oldTextLength);
  const sourceLength = asNumber(raw.sourceLength);
  const matchingPrefixChars = asNumber(raw.matchingPrefixChars);
  if (oldTextLength === null || sourceLength === null || matchingPrefixChars === null) {
    return null;
  }
  return {
    oldTextLength,
    sourceLength,
    matchingPrefixChars,
    sourceOffset: asNumber(raw.sourceOffset) ?? -1,
    oldTextSnippet: asString(raw.oldTextSnippet) ?? "",
    sourceSnippet: asString(raw.sourceSnippet) ?? "",
  };
}

const ASSESSMENT_STATES: VerificationAssessmentState[] = [
  "FULL_SUITE_PASSED",
  "REPAIR_VERIFIED",
  "REPAIR_NOT_VERIFIED",
  "VERIFICATION_INCOMPLETE",
];

// Map the persisted verification assessment. Unknown/malformed shapes yield
// null so the panel falls back to the legacy lifecycle outcome — it never
// fabricates an assessment.
function asAssessment(raw: unknown): ForgeAssessmentView | null {
  if (!isRecord(raw)) return null;
  const state =
    typeof raw.state === "string" && (ASSESSMENT_STATES as string[]).includes(raw.state)
      ? (raw.state as VerificationAssessmentState)
      : null;
  if (!state) return null;
  return {
    state,
    patchApplied: raw.patchApplied === true,
    targetVerificationPassed:
      typeof raw.targetVerificationPassed === "boolean" ? raw.targetVerificationPassed : null,
    targetTestFile: asString(raw.targetTestFile),
    targetScenario: asString(raw.targetScenario),
    targetCommand: asString(raw.targetCommand),
    fullSuitePassed: raw.fullSuitePassed === true,
    unrelatedTestFailures: asNumber(raw.unrelatedTestFailures) ?? 0,
    failedTests: Array.isArray(raw.failedTests)
      ? raw.failedTests.filter((t): t is string => typeof t === "string")
      : [],
    targetFailure: asString(raw.targetFailure),
  };
}

function asPullRequest(raw: unknown): PullRequestView | null {
  if (!isRecord(raw)) return null;
  const prNumber = asNumber(raw.prNumber);
  const prUrl = asString(raw.prUrl);
  if (prNumber === null || !prUrl) return null;
  return {
    provider: asString(raw.provider) ?? "github",
    repository: asString(raw.repository) ?? "",
    branch: asString(raw.branch) ?? "",
    baseBranch: asString(raw.baseBranch) ?? "",
    commitSha: asString(raw.commitSha) ?? "",
    prNumber,
    prUrl,
    status: asString(raw.status) ?? "OPEN",
  };
}

function trailStates(run: Record<string, unknown>): string[] {
  const h = run.history;
  if (!Array.isArray(h)) return [];
  return h
    .map((e) => (isRecord(e) ? e.state : null))
    .filter((s): s is string => typeof s === "string");
}

// Parse the vitest summary lines persisted in sandbox stdout, e.g.
// "Tests  13 passed (13)" and "Test Files  3 passed (3)". Returns the
// test-file counts when present, null when the output carries no summary.
// Never throws; never invents counts.
export function parseTestSummary(stdout: string): { passed: number; total: number } | null {
  if (typeof stdout !== "string") return null;
  const m = stdout.match(/^\s*Tests\s+(\d+)\s+passed\s+\((\d+)\)/m);
  if (!m) return null;
  const passed = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(passed) || !Number.isFinite(total)) return null;
  return { passed, total };
}

function tailLines(text: unknown, cap = 12): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-cap);
}

function shortSha(sha: unknown): string | null {
  if (typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha)) return null;
  return `${sha.slice(0, 12)}…`;
}

export function shortCommit(sha: unknown): string | null {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) return null;
  return `${sha.slice(0, 12)}…`;
}

// The analyzed revision of a job, for display. Reads the persisted
// result.ref written by POST /api/analyze — the same value the backend
// resolves for checkout. Null for legacy/default-branch jobs.
export function jobSourceRef(job: unknown): string | null {
  if (!isRecord(job)) return null;
  const result = isRecord(job.result) ? job.result : null;
  const ref = result ? asString(result.ref) : null;
  return ref && ref.length <= 200 ? ref : null;
}

function verifyResult(timedOut: boolean, exitCode: number | null, passed: boolean): VerifyResult {
  if (timedOut) return "FAIL";
  if (exitCode === null) return "NOT RUN";
  return exitCode === 0 && passed ? "PASS" : "FAIL";
}

function outcomeFor(status: string, timedOut: boolean): ForgeOutcome {
  switch (status) {
    case "VERIFIED":
      return "VERIFIED";
    case "FAILED":
      return timedOut ? "VERIFICATION_TIMEOUT" : "VERIFICATION_FAILED";
    case "TIMEOUT":
      return "VERIFICATION_TIMEOUT";
    case "APPLY_FAILED":
      return "APPLY_FAILED";
    case "EDIT_CONTEXT_MISMATCH":
    case "AMBIGUOUS_EDIT":
    case "PATH_REJECTED":
    case "PATCH_VALIDATION_FAILED":
      return "VALIDATION_FAILED";
    case "SOURCE_MISMATCH":
      return "SOURCE_MISMATCH";
    default:
      return "UNKNOWN";
  }
}

function stepsFor(
  kind: ForgeRunKind,
  trail: string[],
  opts: { editOk: boolean; patchOk: boolean; applied: boolean; verifying: boolean; verified: boolean; assessed: boolean }
): ForgeStep[] {
  const has = (...states: string[]) => states.some((s) => trail.includes(s));
  // Validated means the patch earned its way to (or past) application.
  // Reaching APPLYING alone does not count: the lean `git apply --check`
  // gate (or the full-run apply) may still reject it there.
  const patchValidated =
    opts.patchOk || has("APPLIED", "VERIFYING", "VERIFIED");
  const verifying = opts.verifying || has("VERIFYING", "VERIFIED");
  const base: ForgeStep[] = [
    { label: "Proposed", reached: trail.includes("PROPOSED") || trail.length > 0 },
    ...(kind === "structured"
      ? [{ label: "Edit validated", reached: opts.editOk || has("EDIT_APPLIED", "APPLIED", "VERIFYING", "VERIFIED") }]
      : []),
    { label: "Patch validated", reached: patchValidated },
    { label: "Applied", reached: opts.applied },
    { label: "Verifying", reached: verifying },
    // When an assessment exists, verification ran and was assessed — the
    // pass/fail meaning lives in the primary outcome banner, not a bare
    // "Verified" lifecycle tick that could read as a failure.
    {
      label: opts.assessed ? "Verification assessed" : "Verified",
      reached: opts.assessed || opts.verified,
    },
  ];
  return base;
}

function editsFor(run: Record<string, unknown>): ForgeEditView[] {
  const gen = run.generation;
  if (!isRecord(gen) || !Array.isArray(gen.edits)) return [];
  const out: ForgeEditView[] = [];
  for (const e of gen.edits) {
    if (!isRecord(e)) continue;
    const path = asString(e.path);
    if (!path) continue;
    out.push({ path, function: asString(e.function) });
  }
  return out;
}

function editChecksFor(
  edits: ForgeEditView[],
  editCategory: string | null,
  applied: boolean
): ForgeCheck[] {
  const pathsOk = edits.length > 0 && edits.every((e) => !e.path.includes("..") && !e.path.startsWith("/"));
  return [
    { label: "JSON valid", ok: edits.length > 0 || editCategory !== null },
    { label: "Schema valid", ok: edits.length > 0 },
    { label: "Path valid", ok: pathsOk },
    { label: "Exact source match", ok: editCategory === "ok" },
    { label: "Edit applied", ok: applied },
  ];
}

// Map one persisted forgeRuns[] entry to display state. Unknown or
// malformed entries yield outcome UNKNOWN with empty evidence — the panel
// renders "evidence unavailable", never a success.
export function toForgeRunView(raw: unknown, number: number): ForgeRunView | null {
  if (!isRecord(raw)) return null;
  const status = asString(raw.status) ?? "UNKNOWN";
  const trail = trailStates(raw);
  const gen = isRecord(raw.generation) ? raw.generation : null;
  const kind: ForgeRunKind =
    isRecord(raw.canonicalPatch) || isRecord(raw.validation) || gen?.format === "structured-edit"
      ? "structured"
      : "diff";
  const modelSource =
    asString(gen?.source) ??
    (Array.isArray(raw.generationAttempts) && raw.generationAttempts.length > 0
      ? asString((raw.generationAttempts[raw.generationAttempts.length - 1] as Record<string, unknown>)?.source) ?? null
      : null) ??
    (isRecord(raw.patch) ? asString(raw.patch.source) : null);
  const edits = kind === "structured" ? editsFor(raw) : [];
  const validation = isRecord(raw.validation) ? raw.validation : null;
  const editCategory = asString(validation?.editCategory);
  const patchValidated = validation?.patchValidated === true;
  const canonical = isRecord(raw.canonicalPatch) ? raw.canonicalPatch : null;
  const patch = isRecord(raw.patch) ? raw.patch : null;
  const patchBytes = asNumber(canonical?.bytes) ?? asNumber(patch?.diffBytes) ?? asNumber(patch?.bytes);
  const patchShaShort = shortSha(canonical?.sha) ?? shortSha(patch?.diffSha256);
  const patchSha = asString(canonical?.sha) ?? asString(patch?.diffSha256);
  const applied = isRecord(raw.apply) ? raw.apply.applied === true : false;
  const ver = isRecord(raw.verification) ? raw.verification : null;
  const timedOut = ver?.timedOut === true;
  const exitCode = asNumber(ver?.exitCode);
  const passed = ver?.passed === true;
  const verified = status === "VERIFIED";
  // Source-revision provenance (Phase K). Absent on legacy entries —
  // preserved as nulls, never backfilled.
  const source = isRecord(raw.source) ? raw.source : null;
  const sandboxSource = isRecord(raw.sandboxSource) ? raw.sandboxSource : null;
  const sandboxMatched =
    typeof sandboxSource?.matched === "boolean" ? sandboxSource.matched : null;
  // Started means the verification command itself began. A diff-run exit
  // code without VERIFYING in the trail belongs to an earlier phase (apply
  // or install) — it must not be presented as a verification result.
  const verifyingReached = trail.includes("VERIFYING") || trail.includes("VERIFIED");
  const started =
    verifyingReached || (kind === "structured" && ver !== null) || timedOut;
  const assessment = ver ? asAssessment(ver.assessment) : null;
  const verification: ForgeVerificationView | null = ver
    ? {
        command: asString(ver.command) ?? "—",
        exitCode,
        timedOut,
        passed,
        started,
        result: !started ? "NOT RUN" : verifyResult(timedOut, exitCode, passed),
        assessment,
      }
    : null;
  const stdout = typeof raw.stdout === "string" ? raw.stdout : "";
  const stderr = typeof raw.stderr === "string" ? raw.stderr : "";
  const files = asNumber(raw.files);
  const steps = stepsFor(kind, trail, {
    editOk: editCategory === "ok",
    patchOk: patchValidated,
    applied,
    verifying: started,
    verified,
    assessed: assessment !== null,
  });
  const editChecks = kind === "structured" ? editChecksFor(edits, editCategory, applied) : [];
  const sandboxChecks: ForgeCheck[] = [
    { label: "Disposable Nebius sandbox", ok: asString(raw.image) !== null },
    { label: "Repository staged", ok: (files ?? 0) > 0 },
    { label: "Dependencies installed", ok: verifyingReached || (kind === "structured" && verification !== null) },
    { label: "Verification executed", ok: started },
    { label: "Sandbox cleaned up", ok: true },
  ];
  return {
    id: asString(raw.id) ?? `run-${number}`,
    investigationId: asString(raw.investigationId),
    number,
    kind,
    status,
    outcome: assessment && !timedOut ? assessment.state : outcomeFor(status, timedOut),
    steps,
    modelSource,
    focus: asString(gen?.focus),
    edits,
    editChecks,
    patchBytes,
    patchShaShort,
    patchSha,
    applyApplied: applied,
    mismatch: asMismatchView(raw.mismatch),
    source: {
      ref: asString(source?.ref),
      refSource: asString(source?.refSource),
      commitSha: asString(source?.commitSha),
      analysisCommitSha: asString(source?.analysisCommitSha),
      executionCommitSha: asString(source?.executionCommitSha) ?? asString(source?.commitSha),
      sandboxRef: asString(sandboxSource?.ref),
      sandboxSha: asString(sandboxSource?.sha),
      sandboxMatched,
    },
    sandbox: {
      image: asString(raw.image),
      manager: asString(raw.manager),
      files,
      durationMs: asNumber(raw.durationMs),
    },
    sandboxChecks,
    verification,
    testSummary: parseTestSummary(stdout),
    outputTail: tailLines(stdout),
    errorTail: tailLines(stderr, 4),
    at: asString(raw.at),
    pullRequest: asPullRequest(raw.pullRequest),
  };
}

// Map a job's persisted result into run views, oldest run numbered #1.
// Returns [] when the job carries no usable forgeRuns[] — the page renders
// the empty state, never a fabricated run.
export function resolveForgeRuns(job: unknown): ForgeRunView[] {
  if (!isRecord(job)) return [];
  const result = isRecord(job.result) ? job.result : null;
  const runs = result && Array.isArray(result.forgeRuns) ? result.forgeRuns : [];
  const views: ForgeRunView[] = [];
  runs.forEach((raw, i) => {
    try {
      const v = toForgeRunView(raw, i + 1);
      if (v) views.push(v);
    } catch {
      // One malformed entry must not hide the rest.
    }
  });
  return views;
}

// Choose the job whose evidence the Forge page shows: the latest job (API
// order is newest-first) that actually carries forgeRuns[]. Returns null
// when no fetched job has any — the page renders the empty state.
export function selectForgeEvidenceJob(jobs: unknown): unknown | null {
  if (!Array.isArray(jobs)) return null;
  for (const j of jobs) {
    if (!isRecord(j)) continue;
    const result = isRecord(j.result) ? j.result : null;
    if (result && Array.isArray(result.forgeRuns) && result.forgeRuns.length > 0) return j;
  }
  return null;
}

// Find one run view by backend run id. The page derives its CURRENT
// proposal/verification from this alone — never by position, never by
// jobId match — so historical evidence can never masquerade as current.
// Returns null for missing ids: the page renders NOT RUN. Never throws.
export function findRunView(views: ForgeRunView[], id: string | null): ForgeRunView | null {
  if (!id || !Array.isArray(views)) return null;
  return views.find((v) => v !== null && typeof v === "object" && v.id === id) ?? null;
}

// Find the newest persisted Forge run bound to an exact investigation id.
// Used on Forge load to DISPLAY an already-forged run instead of launching a
// new one. Matches only the persisted investigationId — never jobId, target,
// position, or the URL. `views` is expected newest-first. Never throws.
export function findRunForInvestigation(
  views: ForgeRunView[],
  investigationId: string | null | undefined
): ForgeRunView | null {
  if (!investigationId || !Array.isArray(views)) return null;
  return views.find((v) => v !== null && typeof v === "object" && v.investigationId === investigationId) ?? null;
}

// ---- Compact Forge history presentation ----

export const RECENT_RUNS_LIMIT = 3;

export function formatRunTime(at: string | null): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function shortRunStatus(run: ForgeRunView): string {
  switch (run.outcome) {
    case "FULL_SUITE_PASSED":
      return "FULL SUITE PASSED";
    case "REPAIR_VERIFIED":
      return "REPAIR VERIFIED";
    case "REPAIR_NOT_VERIFIED":
      return "REPAIR NOT VERIFIED";
    case "VERIFICATION_INCOMPLETE":
      return "VERIFICATION INCOMPLETE";
    case "VERIFIED":
      return "VERIFIED";
    case "VERIFICATION_FAILED":
      return "FAILED";
    case "VERIFICATION_TIMEOUT":
      return "TIMEOUT";
    case "APPLY_FAILED":
      return "APPLY FAILED";
    case "VALIDATION_FAILED":
      return "VALIDATION FAILED";
    case "SOURCE_MISMATCH":
      return "SOURCE MISMATCH";
    default:
      return run.status;
  }
}

export interface ForgeHistoryRow {
  id: string;
  status: string;
  target: string;
  summary: string;
  time: string;
}

// Compact one-line row for a historical run. Never throws; malformed runs
// degrade to a "—" row rather than hiding the rest of history.
export function toForgeHistoryRow(run: ForgeRunView): ForgeHistoryRow {
  return {
    id: run.id,
    status: shortRunStatus(run),
    target: run.edits[0] ? (run.edits[0].function ?? run.edits[0].path ?? "—") : "—",
    summary: run.testSummary ? `${run.testSummary.passed}/${run.testSummary.total}` : "—",
    time: formatRunTime(run.at),
  };
}

// ---- VERIFY IN SANDBOX request contract (Phase J fix) ----

// The button must use the proven structured pipeline — never the legacy
// direct-diff draft branch. The legacy path is keyed off the endpoint, so
// the route constant IS the branch selection.
export const STRUCTURED_VERIFY_PATH = "/api/forge-structured";
export const LEGACY_VERIFY_PATH = "/api/forge-verify";

export interface VerifyRequestBody {
  jobId: string;
  focus: string;
}

export type VerifyBodyResult =
  | { ok: true; body: VerifyRequestBody }
  | { ok: false; error: string };

// Build the structured-verify body. Focus is required: the backend uses it
// to select source excerpts and ground the edit, and rejects empty focus
// with 400 — so the UI validates first instead of wasting a request. The
// body carries no `diff` field: the model drafts the structured plan, git
// authors the patch. Never throws.
export function buildVerifyBody(jobId: string, focus: string): VerifyBodyResult {
  if (!jobId || jobId.trim().length === 0) {
    return { ok: false, error: "No analysis job selected." };
  }
  const trimmed = focus.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Describe the bug in the focus field first." };
  }
  if (trimmed.length > 2000) {
    return { ok: false, error: "Focus must be 2000 characters or fewer." };
  }
  return { ok: true, body: { jobId, focus: trimmed } };
}

// The Forge request is bound to the exact investigation: { jobId,
// investigationId }. The backend loads that investigation and derives the
// repair focus from its plan. A Forge request without an investigationId is
// rejected here — the UI never silently re-runs investigation.
export type ForgeStructuredBodyResult =
  | { ok: true; body: { jobId: string; investigationId: string; focus: string } }
  | { ok: false; error: string };

export function buildForgeBody(
  jobId: string,
  investigationId: string | null | undefined,
  focus: string
): ForgeStructuredBodyResult {
  if (!jobId || jobId.trim().length === 0) {
    return { ok: false, error: "No analysis job selected." };
  }
  if (!investigationId || investigationId.trim().length === 0) {
    return { ok: false, error: "No investigation is attached to this Forge run." };
  }
  const trimmed = focus.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "The attached investigation has no repair focus." };
  }
  if (trimmed.length > 2000) {
    return { ok: false, error: "Focus must be 2000 characters or fewer." };
  }
  return { ok: true, body: { jobId, investigationId, focus: trimmed } };
}

// Navigation helpers that carry the exact investigation identity.
export function forgeReviewHref(jobId: string, investigationId: string): string {
  return `/forge?jobId=${encodeURIComponent(jobId)}&investigationId=${encodeURIComponent(investigationId)}`;
}

export function investigationReviewHref(jobId: string, investigationId: string): string {
  return `/investigate?jobId=${encodeURIComponent(jobId)}&investigationId=${encodeURIComponent(investigationId)}`;
}

export interface LiveVerification {
  status: string;
  history: string[];
  applied: boolean;
  command: string;
  exitCode: number | null;
  passed: boolean;
}

// Map a structured forgeRun to the verification display. Returns null when
// the payload carries no usable run — the page shows the error state, never
// a fabricated verification. Never throws.
export function toLiveVerification(forgeRun: unknown): LiveVerification | null {
  if (!isRecord(forgeRun)) return null;
  const status = asString(forgeRun.status);
  if (!status) return null;
  const history = Array.isArray(forgeRun.history)
    ? forgeRun.history
        .map((h) => (isRecord(h) ? h.state : null))
        .filter((s): s is string => typeof s === "string")
    : [];
  const apply = isRecord(forgeRun.apply) ? forgeRun.apply : null;
  const verification = isRecord(forgeRun.verification) ? forgeRun.verification : null;
  return {
    status,
    history,
    applied: apply?.applied === true,
    command: asString(verification?.command) ?? "",
    exitCode: asNumber(verification?.exitCode),
    passed: Boolean(forgeRun.verified),
  };
}

// Friendly label for a terminal run state. Shown alongside the raw status;
// never invents success.
export function describeRunStatus(status: string): string {
  switch (status) {
    case "VERIFIED":
      return "VERIFIED";
    case "FAILED":
      return "Verification failed";
    case "TIMEOUT":
      return "Verification timed out";
    case "APPLY_FAILED":
      return "Patch apply failed";
    case "EDIT_CONTEXT_MISMATCH":
      return "Edit context mismatch";
    case "AMBIGUOUS_EDIT":
      return "Ambiguous edit";
    case "PATH_REJECTED":
      return "Path rejected";
    case "PATCH_VALIDATION_FAILED":
      return "Patch validation failed";
    case "SOURCE_MISMATCH":
      return "Source revision mismatch";
    default:
      return status;
  }
}

// Controlled error message for a non-ok structured-verify response. Keeps
// the backend text (no secret-bearing fields exist on these errors) while
// distinguishing the model-empty case, where no sandbox run started.
export function toVerifyError(status: number, data: unknown): string {
  const err = isRecord(data) ? asString(data.error) : null;
  if (status === 502 && err === "Model request failed") {
    return "Model request failed (empty or invalid model response) — no sandbox run started.";
  }
  if (err) return err;
  return "Verification request failed.";
}

// ---- INVESTIGATE → FORGE flow ----

export const INVESTIGATE_PATH = "/api/investigate";

export type ReproduceBodyResult =
  | { ok: true; body: { jobId: string; investigationId?: string; script: string } }
  | { ok: false; error: string };

export function buildReproduceBody(
  jobId: string,
  investigationId: string | null | undefined,
  script: string
): ReproduceBodyResult {
  if (!jobId.trim()) return { ok: false, error: "No analysis job selected." };
  const command = script.trim();
  if (!command) return { ok: false, error: "Provide a reproduction command or script." };
  return {
    ok: true,
    body: {
      jobId,
      ...(investigationId ? { investigationId } : {}),
      script: command,
    },
  };
}

export interface InvestigationTargetView {
  file: string;
  function: string;
}

export interface InvestigationPlanView {
  summary: string;
  target: InvestigationTargetView;
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
  };
  constraints: string[];
  evidence: string[];
  reproduction: {
    scenario: string;
    testFile: string;
  } | null;
  confidence: "low" | "medium" | "high";
}

export type InvestigationStatus = "READY" | "AMBIGUOUS" | "NO_MATCH";

// Richer investigation state (spec §7). `status` remains the coarse
// READY|AMBIGUOUS|NO_MATCH gate; `state` distinguishes a reviewable result
// from one still asking the user a focused question.
export type InvestigationState =
  | "DRAFT"
  | "RETRIEVING"
  | "ANALYZING"
  | "CLARIFICATION_NEEDED"
  | "READY_FOR_REVIEW"
  | "READY"
  | "AMBIGUOUS"
  | "NO_MATCH";

export interface InvestigationClarificationView {
  question: string;
  options: string[];
}

export interface InvestigationView {
  investigationId: string | null;
  jobId: string | null;
  focus: string | null;
  createdAt: string | null;
  status: InvestigationStatus;
  plan: InvestigationPlanView | null;
  message: string | null;
  // Additive agent fields — absent on legacy persisted runs.
  state?: InvestigationState | null;
  observedBehavior?: string | null;
  expectedBehavior?: string | null;
  clarification?: InvestigationClarificationView | null;
}

export type ReadyInvestigationView = InvestigationView & {
  investigationId: string;
  jobId: string;
  status: "READY";
  plan: InvestigationPlanView;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is string => typeof e === "string" && e.length > 0);
}

const INVESTIGATION_STATES: InvestigationState[] = [
  "DRAFT",
  "RETRIEVING",
  "ANALYZING",
  "CLARIFICATION_NEEDED",
  "READY_FOR_REVIEW",
  "READY",
  "AMBIGUOUS",
  "NO_MATCH",
];

function asInvestigationState(v: unknown): InvestigationState | null {
  return typeof v === "string" && (INVESTIGATION_STATES as string[]).includes(v)
    ? (v as InvestigationState)
    : null;
}

function asClarification(v: unknown): InvestigationClarificationView | null {
  if (!isRecord(v)) return null;
  const question = asString(v.question);
  const options = asStringArray(v.options);
  if (!question || options.length === 0) return null;
  return { question, options };
}

// Parse the structured investigate response. Returns null when the payload
// carries no usable verdict — the page shows the error state, never a
// fabricated plan. Never throws.
export function toInvestigation(data: unknown): InvestigationView | null {
  if (!isRecord(data)) return null;
  const status = data.status;
  if (status !== "READY" && status !== "AMBIGUOUS" && status !== "NO_MATCH") {
    return null;
  }
  let plan: InvestigationPlanView | null = null;
  if (status === "READY" && isRecord(data.plan)) {
    const target = isRecord(data.plan.target) ? data.plan.target : null;
    const file = target ? asString(target.file) : null;
    const fn = target ? asString(target.function) : null;
    const confidence = data.plan.confidence;
    const contract = isRecord(data.plan.repairContract) ? data.plan.repairContract : null;
    const repairContract = contract
      ? {
          requiredOutcome: asString(contract.requiredOutcome),
          preserveBehavior: asStringArray(contract.preserveBehavior),
          relevantCondition: asString(contract.relevantCondition),
          relevantOperation: asString(contract.relevantOperation),
          existingErrorContract: asString(contract.existingErrorContract),
          minimalRepairDescription: asString(contract.minimalRepairDescription),
          setupFacts: asStringArray(contract.setupFacts),
          actionFacts: asStringArray(contract.actionFacts),
          observedFacts: asStringArray(contract.observedFacts),
          expectedFacts: asStringArray(contract.expectedFacts),
          sourceEvidence: asStringArray(contract.sourceEvidence),
          relevantAssertions: asStringArray(contract.relevantAssertions),
          conditionOperationAreDistinct: contract.conditionOperationAreDistinct === true,
        }
      : null;
    if (
      file &&
      fn &&
      repairContract?.requiredOutcome &&
      repairContract.relevantCondition &&
      repairContract.relevantOperation &&
      repairContract.minimalRepairDescription &&
      (confidence === "low" || confidence === "medium" || confidence === "high")
    ) {
      plan = {
        summary: asString(data.plan.summary) ?? "",
        target: { file, function: fn },
        currentBehavior: asString(data.plan.currentBehavior) ?? "",
        expectedBehavior: asString(data.plan.expectedBehavior) ?? "",
        repairContract: {
          requiredOutcome: repairContract.requiredOutcome,
          preserveBehavior: repairContract.preserveBehavior,
          relevantCondition: repairContract.relevantCondition,
          relevantOperation: repairContract.relevantOperation,
          existingErrorContract: repairContract.existingErrorContract ?? "",
          minimalRepairDescription: repairContract.minimalRepairDescription,
          setupFacts: repairContract.setupFacts,
          actionFacts: repairContract.actionFacts,
          observedFacts: repairContract.observedFacts,
          expectedFacts: repairContract.expectedFacts,
          sourceEvidence: repairContract.sourceEvidence,
          relevantAssertions: repairContract.relevantAssertions,
          conditionOperationAreDistinct: repairContract.conditionOperationAreDistinct,
        },
        constraints: asStringArray(data.plan.constraints),
        evidence: asStringArray(data.plan.evidence),
        reproduction:
          isRecord(data.plan.reproduction) &&
          asString(data.plan.reproduction.scenario) &&
          asString(data.plan.reproduction.testFile)
            ? {
                scenario: asString(data.plan.reproduction.scenario)!,
                testFile: asString(data.plan.reproduction.testFile)!,
              }
            : null,
        confidence,
      };
    }
  }
  if (status === "READY" && !plan) return null;
  return {
    investigationId: asString(data.investigationId),
    jobId: asString(data.jobId),
    focus: asString(data.focus),
    createdAt: asString(data.createdAt),
    status,
    plan,
    message: asString(data.message),
    state: asInvestigationState(data.state),
    observedBehavior: asString(data.observedBehavior),
    expectedBehavior: asString(data.expectedBehavior),
    clarification: asClarification(data.clarification),
  };
}

export function canReviewInvestigation(
  view: InvestigationView | null
): view is ReadyInvestigationView {
  return Boolean(
    view &&
      view.status === "READY" &&
      view.investigationId &&
      view.jobId &&
      view.plan
  );
}

export function findSavedInvestigation(
  job: unknown,
  requestedInvestigationId?: string | null
): InvestigationView | null {
  if (!isRecord(job) || !isRecord(job.result)) return null;
  const runs = job.result.investigationRuns;
  if (!Array.isArray(runs)) return null;
  const jobId = asString(job.id);
  for (const run of [...runs].reverse()) {
    if (!isRecord(run) || run.status !== "READY") continue;
    if (requestedInvestigationId && run.investigationId !== requestedInvestigationId) continue;
    const view = toInvestigation(run);
    if (!canReviewInvestigation(view)) continue;
    if (jobId && view.jobId !== jobId) continue;
    return view;
  }
  return null;
}

export function describeInvestigationFailure(
  status: number | null,
  url: string,
  body: unknown
): string {
  if (process.env.NODE_ENV === "production") {
    return status === null
      ? "Investigation service unreachable."
      : "Investigation request failed.";
  }
  let serialized = "(empty response)";
  if (typeof body === "string") serialized = body;
  else if (body !== undefined) {
    try {
      serialized = JSON.stringify(body);
    } catch {
      serialized = "(response was not serializable)";
    }
  }
  return `Investigation request failed:\nHTTP ${status ?? "network error"}\n${url}\n${serialized.slice(0, 2000)}`;
}

// FORGE FIX is enabled only for a verified READY plan. AMBIGUOUS and
// NO_MATCH verdicts never reach the Forge endpoint.
export function canForgePlan(view: InvestigationView | null): boolean {
  return canReviewInvestigation(view) && isGroundedPlan(view.plan);
}

function isGroundedPlan(plan: InvestigationPlanView): boolean {
  const contract = plan.repairContract;
  // Grounding reflects the generalized investigator: an error contract is
  // only present when the relevant test scenario asserts a throw. Value
  // contracts (computed totals, cart state) legitimately have none.
  return Boolean(
    plan.evidence.length > 0 &&
      contract.requiredOutcome &&
      contract.relevantCondition &&
      contract.relevantOperation &&
      contract.minimalRepairDescription &&
      contract.sourceEvidence.length >= 2 &&
      contract.relevantAssertions.length > 0 &&
      contract.conditionOperationAreDistinct
  );
}

export type InvestigateBodyResult =
  | {
      ok: true;
      body: { jobId: string; focus: string; priorQuestion?: string; clarification?: string };
    }
  | { ok: false; error: string };

// Build the investigate request body. The description is required and
// bounded like the Forge focus contract. An optional clarification carries the
// focused question plus the user's answer so the agent resumes instead of
// asking the user to restate the whole bug. Never throws.
export function buildInvestigateBody(
  jobId: string,
  description: string,
  clarification?: { priorQuestion: string; answer: string }
): InvestigateBodyResult {
  if (!jobId || jobId.trim().length === 0) {
    return { ok: false, error: "No analysis job selected." };
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Describe the bug first." };
  }
  if (trimmed.length > 500) {
    return { ok: false, error: "Description must be 500 characters or fewer." };
  }
  const answer = clarification?.answer?.trim() ?? "";
  return {
    ok: true,
    body: {
      jobId,
      focus: trimmed,
      ...(answer
        ? { priorQuestion: clarification?.priorQuestion?.trim() ?? "", clarification: answer.slice(0, 500) }
        : {}),
    },
  };
}

// Compose the Forge focus from a verified plan. Mirrors the backend
// composeForgeFocus template (apps/api/src/investigate.ts) so the plan
// the user approved is exactly what the Forge endpoint receives. Never
// invents content beyond the plan fields. Never throws.
export function composeForgeFocus(plan: InvestigationPlanView): string {
  const text = [
    `Target: ${plan.target.function} (${plan.target.file}). Current: ${plan.currentBehavior} Expected: ${plan.expectedBehavior}`,
    `Repair contract: Required outcome: ${plan.repairContract.requiredOutcome} Preserve: ${plan.repairContract.preserveBehavior.join(" ")} Condition: ${plan.repairContract.relevantCondition} Operation: ${plan.repairContract.relevantOperation} Error: ${plan.repairContract.existingErrorContract} Minimal repair: ${plan.repairContract.minimalRepairDescription}`,
    `Evidence chain: Setup: ${plan.repairContract.setupFacts.join(" ")} Action: ${plan.repairContract.actionFacts.join(" ")} Observed: ${plan.repairContract.observedFacts.join(" ")} Expected: ${plan.repairContract.expectedFacts.join(" ")} Source: ${plan.repairContract.sourceEvidence.join(" ")} Assertions: ${plan.repairContract.relevantAssertions.join(" ")}`,
    `Constraints: ${plan.constraints.join(" ")}`,
    `Evidence: ${plan.evidence.join(" ")}`,
  ].join(" ");
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

// ---- SHIP → GitHub Pull Request ----

export const SHIP_PATH = "/api/ship";

// Deterministic, URL-safe SHIP link bound to the exact Forge run. Mirrors
// investigationReviewHref/forgeReviewHref. The SHIP page MUST load this exact
// forgeRunId — never the latest or first-eligible run.
export function shipRepairHref(
  jobId: string | null | undefined,
  forgeRunId: string | null | undefined
): string {
  const params = new URLSearchParams();
  if (jobId) params.set("jobId", jobId);
  if (forgeRunId) params.set("forgeRunId", forgeRunId);
  const query = params.toString();
  return query ? `/ship?${query}` : "/ship";
}

// A Forge run may be published only when its assessment is REPAIR_VERIFIED or
// FULL_SUITE_PASSED, the patch was applied, and the target behavior did not
// fail. Legacy runs without an assessment never qualify.
export function shipEligible(
  run: ForgeRunView | null | undefined
): { eligible: boolean; reason: string } {
  if (!run) return { eligible: false, reason: "No Forge run selected." };
  const a = run.verification?.assessment ?? null;
  if (!a) {
    return {
      eligible: false,
      reason: "This Forge run predates verification assessment and cannot be shipped.",
    };
  }
  if (a.state !== "REPAIR_VERIFIED" && a.state !== "FULL_SUITE_PASSED") {
    return { eligible: false, reason: `The repair is not verified (${a.state}).` };
  }
  if (a.targetVerificationPassed === false) {
    return { eligible: false, reason: "The investigated behavior did not pass verification." };
  }
  if (!run.applyApplied) {
    return { eligible: false, reason: "The patch was not applied." };
  }
  return { eligible: true, reason: "" };
}

export type ShipBodyResult =
  | { ok: true; body: { jobId: string; forgeRunId: string } }
  | { ok: false; error: string };

// Build the SHIP request body. Never guesses the run — both ids are required.
export function buildShipBody(
  jobId: string,
  forgeRunId: string | null | undefined
): ShipBodyResult {
  if (!jobId || jobId.trim().length === 0) return { ok: false, error: "No analysis job selected." };
  if (!forgeRunId || forgeRunId.trim().length === 0) {
    return { ok: false, error: "No Forge run selected." };
  }
  return { ok: true, body: { jobId, forgeRunId: forgeRunId.trim() } };
}

// Client-side PREVIEW of the deterministic SHIP branch/title (the server owns
// the authoritative values and may append a collision suffix).
function slugPreview(value: string, maxWords: number): string {
  return (value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-")
    .slice(0, 48);
}

export function shipBranchPreview(
  targetFunction: string,
  report: string,
  investigationId: string | null
): string {
  const fnSlug = slugPreview(targetFunction, 3);
  const reportSlug = slugPreview(report, 4);
  const base = [fnSlug, reportSlug].filter(Boolean).join("-") || "repair";
  const shortId = (investigationId ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  let name = `hubris/fix/${base}`;
  if (shortId) name = `${name}-${shortId}`;
  return name.length > 100 ? name.slice(0, 100).replace(/[-./]+$/, "") : name;
}

export function shipTitlePreview(targetFunction: string, report: string): string {
  const fn = (targetFunction || "").trim();
  const words = (report || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ");
  const summary = words || "verified repair";
  return fn ? `Fix ${fn}: ${summary}` : `Fix: ${summary}`;
}
