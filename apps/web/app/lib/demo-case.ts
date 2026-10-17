import { resolveForgeRuns, shipRepairHref } from "./forge-run";

// The fixed public demo case (client-safe constants: no secrets, no env).
// The API enforces the same repository, branch and commands server-side.
export const DEMO_CASE = {
  repository: "kaiser1x/ts-js-dummy",
  repoUrl: "https://github.com/kaiser1x/ts-js-dummy",
  ref: "hubris/buggy-idempotency",
  target: "createPayment() in src/payments.ts",
  // The concrete report the investigation tests prove reaches READY
  // (apps/api/test/helpers/ts-js-dummy.ts REPORT_CLEAN).
  focus:
    "Bug: `createPayment()` in `src/payments.ts` accepts a duplicate idempotency key.\n\n" +
    "Current behavior: Calling `createPayment()` a second time with an idempotency key that was already used successfully creates another payment.\n\n" +
    "Expected behavior: The second call must throw an error containing the existing text `duplicate payment for key` and must not create another payment.\n\n" +
    "Keep first-time payments working normally. Preserve the existing function signature, error messages, and unrelated behavior.",
  reproduceCommand: "pnpm exec vitest run tests/payments.test.ts --reporter=verbose",
  verifyCommand: "pnpm test",
} as const;


export type DemoStepKey = "understand" | "trace" | "investigate" | "reproduce" | "forge" | "verify" | "ship";
export type DemoStepState = "done" | "failed" | "pending";

export interface DemoStep {
  key: DemoStepKey;
  title: string;
  state: DemoStepState;
  // Evidence line taken verbatim from the persisted job; null = not run yet.
  evidence: string | null;
  href: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function last(v: unknown): Record<string, unknown> | null {
  return Array.isArray(v) && v.length > 0 ? rec(v[v.length - 1]) : null;
}

function q(path: string, params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

// The guided steps for a demo job, each with the genuine persisted outcome
// (never inferred, never fabricated). Pure; never throws.
export function demoProgress(job: unknown): DemoStep[] {
  const j = rec(job);
  const jobId = typeof j?.id === "string" ? j.id : null;
  const result = rec(j?.result);
  const stats = rec(result?.stats);
  const analyzed = j?.status === "complete" && stats !== null;

  const inv = last(result?.investigationRuns);
  const invStatus = typeof inv?.status === "string" ? inv.status : null;
  const investigationId = typeof inv?.investigationId === "string" ? inv.investigationId : null;
  const ready = invStatus === "READY" ? investigationId : null;

  const repro = last(result?.reproductions);
  const reproOutcome = typeof repro?.outcome === "string" ? repro.outcome : null;

  const runs = resolveForgeRuns(job);
  const run = runs.length > 0 ? runs[runs.length - 1] : null;

  // VERIFY in the demo is the Forge run's own verification: the targeted
  // regression test and the full suite run on the PATCHED source in the
  // sandbox. (The /verify page checks the unpatched baseline.)
  const assessment = run?.verification?.assessment ?? null;

  return [
    {
      key: "understand",
      title: "Understand",
      state: analyzed ? "done" : j?.status === "failed" ? "failed" : "pending",
      evidence: analyzed
        ? `${stats.functions} functions, ${stats.tests} tests, ${stats.endpoints} endpoints @ ${String(result?.commitSha ?? "").slice(0, 7)}`
        : null,
      href: q("/codebase", { jobId }),
    },
    {
      key: "trace",
      title: "Trace",
      state: analyzed ? "done" : "pending",
      evidence: analyzed ? `${stats.relationships} call relationships mapped` : null,
      href: q("/trace", { jobId }),
    },
    {
      key: "investigate",
      title: "Investigate",
      state: invStatus === "READY" ? "done" : invStatus ? "failed" : "pending",
      evidence: invStatus ? `${invStatus}${investigationId ? ` · ${investigationId.slice(0, 8)}` : ""}` : null,
      href: q("/investigate", { jobId, demo: "1" }),
    },
    {
      key: "reproduce",
      title: "Reproduce",
      state: reproOutcome === "REPRODUCED" ? "done" : reproOutcome ? "failed" : "pending",
      evidence: reproOutcome,
      href: q("/reproduce", { jobId, investigationId: ready, demo: "1" }),
    },
    {
      key: "forge",
      title: "Forge",
      state: run ? (run.status === "VERIFIED" ? "done" : "failed") : "pending",
      evidence: run
        ? `${run.status}${run.testSummary ? ` · ${run.testSummary.passed}/${run.testSummary.total} tests passed` : ""}`
        : null,
      href: ready ? q("/forge", { jobId, investigationId: ready }) : q("/forge", { jobId }),
    },
    {
      key: "verify",
      title: "Verify",
      state: assessment
        ? assessment.targetVerificationPassed === true && assessment.fullSuitePassed
          ? "done"
          : "failed"
        : "pending",
      evidence: assessment
        ? [
            `target test ${assessment.targetVerificationPassed === true ? "passed" : assessment.targetVerificationPassed === false ? "failed" : "not run"}`,
            `full suite ${assessment.fullSuitePassed ? "passed" : "failed"}`,
            run?.testSummary ? `${run.testSummary.passed}/${run.testSummary.total}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
      href: run && ready ? q("/forge", { jobId, investigationId: ready }) : q("/forge", { jobId }),
    },
    {
      key: "ship",
      title: "Ship (read-only)",
      state: "pending",
      evidence: run?.status === "VERIFIED" ? "Patch and provenance available; PR creation is disabled in the demo" : null,
      href: run ? shipRepairHref(jobId, run.id) : q("/ship", { jobId }),
    },
  ];
}

// Interpret an API reply without throwing. Platform error pages are not JSON;
// demo refusals carry an actionable `error` (and a `code`) from the server.
export function readDemoReply(
  status: number,
  text: string
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string; code: string | null } {
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    data = rec(parsed);
  } catch {
    data = null;
  }
  if (status >= 200 && status < 300 && data) return { ok: true, data };
  const code = typeof data?.code === "string" ? data.code : null;
  const error = typeof data?.error === "string" && data.error.length > 0 ? data.error : null;
  if (error) return { ok: false, error, code };
  if (status === 504) {
    return { ok: false, error: "The request timed out before the server answered. Refresh to see whether it finished.", code: null };
  }
  if (status === 429) return { ok: false, error: "Too many demo requests. Wait a minute and try again.", code: null };
  return { ok: false, error: `The demo service answered HTTP ${status}. Try again in a moment.`, code: null };
}
