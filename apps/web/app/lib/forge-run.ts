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

export interface ForgeVerificationView {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  started: boolean;
  result: VerifyResult;
}

export interface ForgeRunView {
  id: string;
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
  applyApplied: boolean;
  // Source-revision provenance. Nulls mean legacy evidence that predates
  // revision tracking — rendered as "—", never backfilled.
  source: {
    ref: string | null;
    refSource: string | null;
    commitSha: string | null;
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
  opts: { editOk: boolean; patchOk: boolean; applied: boolean; verifying: boolean; verified: boolean }
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
    { label: "Verified", reached: opts.verified },
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
  const verification: ForgeVerificationView | null = ver
    ? {
        command: asString(ver.command) ?? "—",
        exitCode,
        timedOut,
        passed,
        started,
        result: !started ? "NOT RUN" : verifyResult(timedOut, exitCode, passed),
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
    number,
    kind,
    status,
    outcome: outcomeFor(status, timedOut),
    steps,
    modelSource,
    focus: asString(gen?.focus),
    edits,
    editChecks,
    patchBytes,
    patchShaShort,
    applyApplied: applied,
    source: {
      ref: asString(source?.ref),
      refSource: asString(source?.refSource),
      commitSha: asString(source?.commitSha),
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
  if (trimmed.length > 500) {
    return { ok: false, error: "Focus must be 500 characters or fewer." };
  }
  return { ok: true, body: { jobId, focus: trimmed } };
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
