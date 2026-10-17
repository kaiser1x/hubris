import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShipDeps } from "../src/ship";
import { analyzeFixtureTwin, TS_JS_DUMMY_DIR, REPORT_CLEAN, type TwinInput } from "./helpers/ts-js-dummy";
import { createSandboxEmulator, makeGitRepo, type SandboxOracle } from "./helpers/sandbox-emulator";

// End-to-end regression for the controlled duplicate-idempotency-key scenario
// (kaiser1x/ts-js-dummy @ hubris/buggy-idempotency):
//
//   INVESTIGATE (clarify → answer → grounded contract)
//     → REPRODUCE (scenario must actually fail)
//     → FORGE (structured edit validated against the analyzed source,
//              canonical patch persisted byte-for-byte)
//     → VERIFY (target scenario separate from the regression suite)
//     → SHIP (eligibility + exact patch/provenance in the PR request)
//
// Every stage runs through the REAL route. Only the model, the sandbox, the
// job store, the clone step and GitHub/git-push are replaced: the model by
// controlled responses, the sandbox by an emulator that runs the real edit
// validator and real `git diff` over a throwaway copy of the repository.

const JOB_ID = "00000000-0000-0000-0000-000000000000";
const ANALYZED_SHA = "4b".repeat(20);
const STALE_SHA = "9f".repeat(20);
const LOCAL_HEAD = "c3".repeat(20);
const REGRESSION_SCENARIO = "rejects a previously seen idempotency key";
const REGRESSION_FILE = "tests/idempotency-regression.test.ts";
const UNRELATED = ["tests/cart.test.ts", "tests/users.test.ts", "tests/sessions.test.ts"];

const ctx = vi.hoisted(() => ({
  job: null as null | { id: string; repoUrl: string; status: string; result: any; error: null },
  repo: null as null | { dir: string; tracked: string[] },
  tarPath: "",
  stagedSha: "" as string,
  emulator: null as any,
  model: ((_text: string): string => "") as (text: string) => string,
  modelCalls: 0,
  gitCalls: [] as string[][],
  writtenPatch: null as string | null,
  diffOverride: null as string | null,
  github: [] as Array<{ method: string; path: string; body: any }>,
}));

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return {
    ...actual,
    chatComplete: vi.fn(async (_cfg: unknown, messages: Array<{ content: string }>) => {
      ctx.modelCalls += 1;
      return ctx.model(messages.map((m) => m.content).join("\n"));
    }),
  };
});

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  return {
    ...actual,
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => (ctx.job ? [ctx.job] : []) }) }),
      update: () => ({
        set: (v: { result?: unknown }) => ({
          where: async () => {
            if (ctx.job) ctx.job = { ...ctx.job, result: v.result };
          },
        }),
      }),
    }),
  };
});

vi.mock("@hubris/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/sandbox")>();
  return {
    ...actual,
    uploadFile: vi.fn((cfg: unknown, bytes: Uint8Array) => ctx.emulator.uploadFile(cfg, bytes)),
    runCommand: vi.fn((cfg: unknown, req: any) => ctx.emulator.runCommand(cfg, req)),
  };
});

vi.mock("../src/checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkout")>();
  return {
    ...actual,
    cloneAndArchive: async () => ({
      src: ctx.repo!.dir,
      tarPath: ctx.tarPath,
      tracked: ctx.repo!.tracked,
      commitSha: ctx.stagedSha,
    }),
  };
});

// SHIP's real orchestration (safety checks, patch reproduction check, branch
// rules, push gating) with fake git + a fake GitHub API.
vi.mock("../src/ship", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ship")>();
  const deps: ShipDeps = {
    exec: async (args) => {
      ctx.gitCalls.push(args);
      const [cmd] = args;
      if (cmd === "rev-parse" && args.includes("--verify")) return { stdout: `${ANALYZED_SHA}\n`, stderr: "" };
      if (cmd === "rev-parse") return { stdout: `${LOCAL_HEAD}\n`, stderr: "" };
      // The staged diff is exactly what `git apply` was given.
      if (cmd === "diff" && args.length === 2 && args[1] === "--cached") {
        return { stdout: ctx.diffOverride ?? ctx.writtenPatch ?? "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    fetchImpl: ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch,
    tmpDir: async () => "/virtual/hubris-ship-e2e",
    removeDir: async () => undefined,
    writeFile: async (_p, content) => {
      ctx.writtenPatch = content;
    },
  };
  return {
    ...actual,
    shipForgeRun: (input: Parameters<typeof actual.shipForgeRun>[0]) => actual.shipForgeRun(input, deps),
  };
});

// ---- the "test runner" oracle: reads the real (edited) working tree ----

let SUITE_UNRELATED: string[] = [];

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const guardPresent = (dir: string) =>
  /seenIdempotencyKeys\.has\(/.test(read(dir, "src/payments.ts")) &&
  read(dir, "src/payments.ts").includes("duplicate payment for key");
const failLine = (file: string, title: string) => ` FAIL  ${file} > ${title}`;
const REGRESSION_TITLE = `idempotency regression (buggy fixture) > ${REGRESSION_SCENARIO}`;

const oracle: SandboxOracle = {
  reproduce(script, dir) {
    if (script.includes("idempotency-regression")) {
      return guardPresent(dir)
        ? { exitCode: 0, output: ` ✓ ${REGRESSION_TITLE} 2ms` }
        : {
            exitCode: 1,
            output: `${failLine(REGRESSION_FILE, REGRESSION_TITLE)}\nAssertionError: expected function to throw an error, but it didn't`,
          };
    }
    if (script.includes("users.test")) {
      return { exitCode: 1, output: `${failLine("tests/users.test.ts", "users > finds a seeded user")}\nAssertionError: unrelated` };
    }
    return { exitCode: 1, output: "No test files found, exiting with code 1" };
  },
  target(dir) {
    return guardPresent(dir)
      ? { exitCode: 0, output: ` ✓ ${REGRESSION_TITLE} 2ms` }
      : { exitCode: 1, output: `${failLine(REGRESSION_FILE, REGRESSION_TITLE)}\nAssertionError: expected function to throw an error` };
  },
  suite(dir) {
    const lines = SUITE_UNRELATED.map((f) => failLine(f, "unrelated > breaks"));
    if (!guardPresent(dir)) lines.push(failLine(REGRESSION_FILE, REGRESSION_TITLE));
    return { exitCode: lines.length > 0 ? 1 : 0, output: lines.join("\n") };
  },
};

// ---- controlled model: understands, selects cited evidence, drafts the edit ----

let EDIT_PLAN: unknown = null;

const OLD_TEXT = [
  "  if (idempotencyKey !== undefined) {",
  "    seenIdempotencyKeys.add(idempotencyKey);",
  "  }",
].join("\n");
const FIX_TEXT = [
  "  if (idempotencyKey !== undefined) {",
  "    if (seenIdempotencyKeys.has(idempotencyKey)) {",
  "      throw new Error(`duplicate payment for key ${idempotencyKey}`);",
  "    }",
  "    seenIdempotencyKeys.add(idempotencyKey);",
  "  }",
].join("\n");

function evidenceIds(prompt: string): Array<{ id: string; type: string; fn: string | null; scenario: string | null }> {
  const out: Array<{ id: string; type: string; fn: string | null; scenario: string | null }> = [];
  const re = /^\[([^\]]+)\] \((source|test|graph|metadata)\) \S+?:\d+(?: · ([A-Za-z0-9_$]+))?(?: · "([^"]+)")?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push({ id: m[1], type: m[2], fn: m[4] ? null : (m[3] ?? null), scenario: m[4] ?? null });
  }
  return out;
}

// The controlled model behaves like a careful one: for a concrete report it
// understands, expands queries, and cites the scenario it actually found; for a
// vague report it cites nothing (and, as real models do, proposes an
// implementation-detail question that HUBRIS must not surface); for an
// unrelated report it finds nothing.
function model(text: string): string {
  const vague = text.includes("Something is wrong with duplicate requests.");
  const unrelated = text.includes("hologram projector");
  if (text.includes("Decompose the report")) {
    return JSON.stringify({
      observedBehavior: unrelated ? "A hologram projector misbehaves" : "A repeated idempotency key creates another payment",
      expectedBehavior: unrelated ? "" : "The repeated key is rejected with 'duplicate payment for key'",
      entities: unrelated ? ["hologram"] : vague ? [] : ["payment", "idempotency key"],
      actions: [],
      ambiguities: [],
      queries: unrelated ? ["hologram projector"] : vague ? [] : ["createPayment idempotency key", "duplicate payment for key"],
    });
  }
  if (text.includes("Retrieved repository evidence")) {
    if (vague || unrelated) {
      return JSON.stringify({
        selectedEvidence: [],
        candidateTarget: null,
        hypothesis: "",
        sufficient: false,
        clarificationQuestion: "Is `seenIdempotencyKeys` declared at module scope, and where are the braces?",
        clarificationOptions: ["It is a const Set", "It is declared inside the function"],
      });
    }
    const units = evidenceIds(text);
    const source = units.find((u) => u.type === "source" && u.fn === "createPayment");
    const scenario = units.find((u) => u.type === "test" && u.scenario === REGRESSION_SCENARIO);
    return JSON.stringify({
      selectedEvidence: [source?.id, scenario?.id].filter(Boolean),
      candidateTarget: "createPayment",
      hypothesis: "createPayment records idempotency keys but never checks them.",
      sufficient: true,
      clarificationQuestion: null,
      clarificationOptions: [],
    });
  }
  // Structured edit draft.
  return JSON.stringify(EDIT_PLAN);
}

// ---- fixtures ----

let REPO: ReturnType<typeof makeGitRepo>;
let TWIN: TwinInput;
let TMP: string;

beforeAll(async () => {
  REPO = makeGitRepo(TS_JS_DUMMY_DIR, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  TWIN = await analyzeFixtureTwin(REPO.dir);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hubris-e2e-tar-"));
  ctx.tarPath = path.join(TMP, "repo.tar");
  fs.writeFileSync(ctx.tarPath, "tarball-bytes-for-the-analyzed-revision");
  ctx.repo = { dir: REPO.dir, tracked: REPO.tracked };
});

afterAll(() => {
  REPO?.cleanup();
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  ctx.stagedSha = ANALYZED_SHA;
  ctx.modelCalls = 0;
  ctx.gitCalls = [];
  ctx.writtenPatch = null;
  ctx.diffOverride = null;
  ctx.github = [];
  ctx.model = model;
  SUITE_UNRELATED = [];
  EDIT_PLAN = { edits: [{ path: "src/payments.ts", function: "createPayment", oldText: OLD_TEXT, newText: FIX_TEXT }] };
  ctx.emulator = createSandboxEmulator(REPO.dir, oracle);
  ctx.job = {
    id: JOB_ID,
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    error: null,
    result: {
      repository: { name: "kaiser1x/ts-js-dummy" },
      ref: "hubris/buggy-idempotency",
      commitSha: ANALYZED_SHA,
      scripts: { test: "vitest run" },
      packageManager: "pnpm",
      stats: {
        functions: TWIN.functions.length,
        classes: 0,
        endpoints: 0,
        tests: TWIN.tests.length,
        relationships: TWIN.relationships.length,
      },
      full: { ...TWIN },
    },
  };
  vi.stubEnv("NEBIUS_API_KEY", "test-key-not-real");
  vi.stubEnv("NEBIUS_MODEL", "test-model");
  vi.stubEnv("NEBIUS_PROJECT_ID", "test-project");
  vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_not_real");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const method = init?.method ?? "GET";
      ctx.github.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.hostname !== "api.github.com") throw new Error(`unexpected network call to ${u.hostname}`);
      if (method === "GET" && u.pathname === "/repos/kaiser1x/ts-js-dummy") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (method === "GET" && u.pathname.endsWith("/pulls")) return new Response("[]", { status: 200 });
      if (method === "POST" && u.pathname.endsWith("/pulls")) {
        return new Response(
          JSON.stringify({ number: 7, html_url: "https://github.com/kaiser1x/ts-js-dummy/pull/7" }),
          { status: 201 }
        );
      }
      return new Response("{}", { status: 404 });
    })
  );
});

afterEach(() => {
  ctx.emulator?.cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- route helpers ----

async function post(route: string, body: Record<string, unknown>) {
  const { app } = await import("../src/app");
  const res = await app.request(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: JOB_ID, ...body }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

const investigate = (body: Record<string, unknown>) => post("/api/investigate", body);
const reproduce = (body: Record<string, unknown>) => post("/api/reproduce", body);
const forge = (body: Record<string, unknown>) => post("/api/forge-structured", body);
const ship = (forgeRunId: string) => post("/api/ship", { forgeRunId });

const persisted = () => ctx.job!.result as any;
const pushes = () => ctx.gitCalls.filter((a) => a[0] === "push");
const prRequests = () => ctx.github.filter((c) => c.method === "POST");

const VAGUE = "Something is wrong with duplicate requests.";

// Drive INVESTIGATE through the clarification and answer it.
async function investigateReady() {
  const asked = await investigate({ focus: VAGUE });
  expect(asked.data.state).toBe("CLARIFICATION_NEEDED");
  const q = asked.data.clarification;
  const choice = q.options.find((o: any) => o.scenario === REGRESSION_SCENARIO);
  expect(choice, "the regression scenario must be offered").toBeDefined();
  const answered = await investigate({
    focus: VAGUE,
    priorInvestigationId: asked.data.investigationId,
    answer: { questionId: q.questionId, optionId: choice.id },
  });
  expect(answered.status).toBe(200);
  return { asked: asked.data, answered: answered.data };
}

describe("duplicate idempotency key: clarification → grounded contract", () => {
  it("asks which test matches, preserves the answer, and becomes READY only with evidence", async () => {
    const { asked, answered } = await investigateReady();

    // 1. A meaningful clarification: two existing tests, stable ids.
    expect(asked.clarification.options.map((o: any) => o.scenario).sort()).toEqual(
      ["rejects a previously seen idempotency key", "rejects duplicate idempotency keys"].sort()
    );
    expect(asked.clarification.question).not.toMatch(/declared|brace|const|let /i);

    // 2. The answer is preserved and drives the contract.
    expect(answered.answer.priorInvestigationId).toBe(asked.investigationId);
    expect(answered.status).toBe("READY");
    expect(answered.state).toBe("READY_FOR_REVIEW");
    expect(answered.plan.target).toEqual({ file: "src/payments.ts", function: "createPayment" });
    expect(answered.plan.reproduction).toEqual({ scenario: REGRESSION_SCENARIO, testFile: REGRESSION_FILE });

    // 3. Grounded in repository facts, not in the model's words.
    const contract = answered.plan.repairContract;
    expect(contract.relevantOperation).toContain("seenIdempotencyKeys.add(idempotencyKey)");
    expect(contract.relevantCondition).toContain("idempotencyKey !== undefined");
    expect(contract.relevantAssertions.join("\n")).toContain("toThrow(/duplicate/i)");
    expect(contract.sourceEvidence.join("\n")).not.toContain("TRAIL");
    expect(answered.retrievedEvidence.every((e: any) => e.provenance.commitSha === ANALYZED_SHA && e.provenance.jobId === JOB_ID)).toBe(true);
    expect(answered.retrievedEvidence.some((e: any) => e.sourceType === "test" && e.file === REGRESSION_FILE)).toBe(true);

    // 4. Persisted for the next stages.
    const saved = persisted().investigationRuns.find((r: any) => r.investigationId === answered.investigationId);
    expect(saved.selections[0].option.scenario).toBe(REGRESSION_SCENARIO);
    expect(saved.source.commitSha).toBe(ANALYZED_SHA);
  });

  it("uses the controlled model for understanding and cited evidence, never for the verdict", async () => {
    const out = await investigate({ focus: REPORT_CLEAN });
    expect(out.status).toBe(200);
    expect(out.data.modelUsed).toBe(true);
    expect(ctx.modelCalls).toBe(2);
    expect(out.data.status).toBe("READY");
    // The model cited the regression scenario; it is the contract's scenario.
    expect(out.data.plan.reproduction.scenario).toBe(REGRESSION_SCENARIO);
  });

  it("rejects a forged option and a stale question without running anything", async () => {
    const asked = await investigate({ focus: VAGUE });
    const calls = ctx.modelCalls;
    const forged = await investigate({
      focus: VAGUE,
      priorInvestigationId: asked.data.investigationId,
      answer: { questionId: asked.data.clarification.questionId, optionId: "opt_not_offered" },
    });
    expect(forged.status).toBe(400);
    const stale = await investigate({
      focus: VAGUE,
      priorInvestigationId: asked.data.investigationId,
      answer: { questionId: "q_stale", optionId: asked.data.clarification.options[0].id },
    });
    expect(stale.status).toBe(409);
    expect(ctx.modelCalls).toBe(calls);
    expect(persisted().investigationRuns).toHaveLength(1);
  });

  it("never repeats the same question without progress: the second run is a specific blocked state", async () => {
    const first = await investigate({ focus: VAGUE });
    const q = first.data.clarification;
    // Refining nothing and asking again yields the SAME question (stable ids).
    const again = await investigate({ focus: VAGUE });
    expect(again.data.clarification.questionId).toBe(q.questionId);
    // But a conversation that already asked it (persisted askedOptionSets) does not ask twice.
    const answered = await investigate({
      focus: VAGUE,
      priorInvestigationId: first.data.investigationId,
      answer: { questionId: q.questionId, optionId: q.options.find((o: any) => o.scenario === "rejects duplicate idempotency keys").id },
    });
    expect(answered.data.clarification).toBeNull();
    expect(answered.data.askedOptionSets).toEqual([q.optionSetKey]);
  });

  it("missing repository evidence is NO_MATCH, never a question or a contract", async () => {
    const out = await investigate({ focus: "The hologram projector is misconfigured." });
    expect(out.data.status).toBe("NO_MATCH");
    expect(out.data.clarification).toBeNull();
    expect(out.data.plan).toBeNull();
  });
});

describe("REPRODUCE demonstrates the reported behavior against the analyzed revision", () => {
  const SCRIPT = `pnpm exec vitest run ${REGRESSION_FILE} --reporter=verbose`;

  it("the investigated scenario failing is REPRODUCED and bound to the investigation + commit", async () => {
    const { answered } = await investigateReady();
    const res = await reproduce({ investigationId: answered.investigationId, script: SCRIPT });
    expect(res.status).toBe(200);
    const ev = res.data.evidence;
    expect(ev.outcome).toBe("REPRODUCED");
    expect(ev.demonstrated).toBe(true);
    expect(ev.investigationId).toBe(answered.investigationId);
    expect(ev.source.analysisCommitSha).toBe(ANALYZED_SHA);
    expect(ev.source.executionCommitSha).toBe(ANALYZED_SHA);
    expect(ev.stdout).toContain(REGRESSION_SCENARIO);
    expect(persisted().reproductions).toHaveLength(1);
  });

  it("a different failing test does NOT reproduce the report", async () => {
    const { answered } = await investigateReady();
    const res = await reproduce({ investigationId: answered.investigationId, script: "pnpm exec vitest run tests/users.test.ts" });
    expect(res.data.evidence.outcome).toBe("UNRELATED_FAILURE");
    expect(res.data.evidence.demonstrated).toBe(false);
  });

  it("a runner that found no tests is an execution failure, not a reproduction", async () => {
    const { answered } = await investigateReady();
    const res = await reproduce({ investigationId: answered.investigationId, script: "pnpm exec vitest run tests/missing.test.ts" });
    expect(res.data.evidence.outcome).toBe("EXECUTION_FAILED");
  });

  it("refuses to run against a repository that moved since analysis (stale revision)", async () => {
    const { answered } = await investigateReady();
    ctx.stagedSha = STALE_SHA;
    const res = await reproduce({ investigationId: answered.investigationId, script: SCRIPT });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/does not match the analyzed commit/i);
    expect(ctx.emulator.runs).toHaveLength(0);
    expect(persisted().reproductions ?? []).toHaveLength(0);
  });
});

describe("FORGE → VERIFY → SHIP", () => {
  async function forgeFromInvestigation() {
    const { answered } = await investigateReady();
    const res = await forge({ focus: "unused: derived from the investigation", investigationId: answered.investigationId });
    expect(res.status).toBe(200);
    return { investigation: answered, run: res.data.forgeRun };
  }

  it("clean suite: the exact patch is persisted, target + suite pass → FULL_SUITE_PASSED → PR with exact provenance", async () => {
    const { investigation, run } = await forgeFromInvestigation();

    // Forge consumed the exact investigation and the analyzed revision.
    expect(run.investigationId).toBe(investigation.investigationId);
    expect(run.source.analysisCommitSha).toBe(ANALYZED_SHA);
    expect(run.source.executionCommitSha).toBe(ANALYZED_SHA);
    expect(run.sandboxSource.matched).toBe(true);
    expect(run.status).toBe("VERIFIED");
    expect(run.apply.applied).toBe(true);

    // Canonical patch: real `git diff` bytes, persisted verbatim, hash-bound.
    const patch = run.canonicalPatch;
    expect(patch.content).toContain("+    if (seenIdempotencyKeys.has(idempotencyKey)) {");
    expect(createHash("sha256").update(patch.content).digest("hex")).toBe(patch.sha);
    expect(Buffer.byteLength(patch.content, "utf8")).toBe(patch.bytes);
    // The analyzed repository itself was not modified.
    expect(fs.readFileSync(path.join(REPO.dir, "src/payments.ts"), "utf8")).not.toContain("seenIdempotencyKeys.has(");

    // The target scenario is verified separately from the regression suite.
    expect(run.targetVerification).toMatchObject({ testFile: REGRESSION_FILE, scenario: REGRESSION_SCENARIO, ran: true, exitCode: 0 });
    const a = run.verification.assessment;
    expect(a).toMatchObject({
      state: "FULL_SUITE_PASSED",
      targetVerificationPassed: true,
      fullSuitePassed: true,
      unrelatedTestFailures: 0,
    });
    expect(a.targetScenario).toBe(REGRESSION_SCENARIO);

    // SHIP permits it and carries the exact patch + provenance.
    const shipped = await ship(run.id);
    expect(shipped.status).toBe(200);
    expect(shipped.data.state).toBe("PR_CREATED");
    expect(ctx.writtenPatch).toBe(patch.content);
    const [pr] = prRequests();
    expect(pr.path).toBe("/repos/kaiser1x/ts-js-dummy/pulls");
    expect(pr.body.body).toContain(`Investigation ID: \`${investigation.investigationId}\``);
    expect(pr.body.body).toContain(`Forge run: \`${run.id}\``);
    expect(pr.body.body).toContain(`Analyzed commit: \`${ANALYZED_SHA}\``);
    expect(pr.body.body).toContain(`Execution commit: \`${ANALYZED_SHA}\``);
    expect(pr.body.body).toContain(`Canonical patch SHA: \`${patch.sha}\``);
    expect(pr.body.body).toContain("Assessment: `FULL_SUITE_PASSED`");
    expect(pr.body.body).toContain("- Result: PASSED");
    expect(pr.body.body).not.toContain("NOT VERIFIED");
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][2]).toMatch(/^HEAD:refs\/heads\/hubris\/fix\//);
  });

  it("3 unrelated suite failures: REPAIR_VERIFIED, reported accurately (never 'pre-existing'), still shippable", async () => {
    SUITE_UNRELATED = UNRELATED;
    const { run } = await forgeFromInvestigation();
    expect(run.status).toBe("FAILED"); // the full suite exited non-zero
    const a = run.verification.assessment;
    expect(a).toMatchObject({
      state: "REPAIR_VERIFIED",
      targetVerificationPassed: true,
      fullSuitePassed: false,
      unrelatedTestFailures: 3,
    });
    expect([...a.failedTests].sort()).toEqual([...UNRELATED].sort());
    // The target's own file is not among the unrelated failures.
    expect(a.failedTests).not.toContain(REGRESSION_FILE);

    const shipped = await ship(run.id);
    expect(shipped.status).toBe(200);
    const body: string = prRequests()[0].body.body;
    expect(body).toContain("- Result: FAILED");
    expect(body).toContain("Unrelated failures: 3");
    for (const f of UNRELATED) expect(body).toContain(`- \`${f}\``);
    expect(body).toContain("Assessment: `REPAIR_VERIFIED`");
    expect(body).not.toMatch(/pre-existing/i);
  });

  it("an edit that does not fix the behavior is REPAIR_NOT_VERIFIED and SHIP is blocked with zero side effects", async () => {
    EDIT_PLAN = {
      edits: [
        {
          path: "src/payments.ts",
          function: "createPayment",
          oldText: "    seenIdempotencyKeys.add(idempotencyKey);",
          newText: "    seenIdempotencyKeys.add(String(idempotencyKey));",
        },
      ],
    };
    const { run } = await forgeFromInvestigation();
    const a = run.verification.assessment;
    expect(a.state).toBe("REPAIR_NOT_VERIFIED");
    expect(a.targetVerificationPassed).toBe(false);
    expect(run.verified).toBe(false);
    const blocked = await ship(run.id);
    expect(blocked.status).toBe(409);
    expect(blocked.data.state).toBe("NOT_READY");
    expect(prRequests()).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
    expect(ctx.gitCalls).toHaveLength(0);
  });

  it("an edit that does not match the analyzed source stops before the sandbox (EDIT_CONTEXT_MISMATCH)", async () => {
    EDIT_PLAN = {
      edits: [{ path: "src/payments.ts", oldText: "  if (idempotencyKey != undefined) {", newText: "  if (false) {" }],
    };
    const { run } = await forgeFromInvestigation();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect(run.canonicalPatch).toBeNull();
    expect(run.verification).toBeNull();
    expect(ctx.emulator.runs).toHaveLength(0);
    expect((await ship(run.id)).status).toBe(409);
  });

  it("Forge refuses a stale repository revision (no sandbox run, no persisted run)", async () => {
    const { answered } = await investigateReady();
    ctx.stagedSha = STALE_SHA;
    const res = await forge({ focus: "x", investigationId: answered.investigationId });
    expect(res.status).toBe(409);
    expect(ctx.emulator.runs).toHaveLength(0);
    expect(persisted().forgeRuns ?? []).toHaveLength(0);
  });

  it("Forge refuses an investigation that is not READY for the contract", async () => {
    const asked = await investigate({ focus: VAGUE });
    const res = await forge({ focus: "x", investigationId: asked.data.investigationId });
    expect(res.status).toBe(400);
    expect(ctx.emulator.runs).toHaveLength(0);
  });

  describe("SHIP fails closed on tampered persisted evidence", () => {
    async function verifiedRun() {
      const { run } = await forgeFromInvestigation();
      expect(run.verification.assessment.state).toBe("FULL_SUITE_PASSED");
      return run;
    }
    function mutate(runId: string, change: (run: any) => void) {
      const result = persisted();
      change(result.forgeRuns.find((r: any) => r.id === runId));
      ctx.job = { ...ctx.job!, result: { ...result } };
    }
    async function expectBlocked(runId: string, status = 409) {
      const res = await ship(runId);
      expect(res.status).toBe(status);
      expect(prRequests()).toHaveLength(0);
      expect(pushes()).toHaveLength(0);
      return res;
    }

    it("missing patch content", async () => {
      const run = await verifiedRun();
      mutate(run.id, (r) => delete r.canonicalPatch.content);
      const res = await expectBlocked(run.id);
      expect(res.data.error).toMatch(/not persisted/i);
    });

    it("patch content that does not match its SHA", async () => {
      const run = await verifiedRun();
      mutate(run.id, (r) => (r.canonicalPatch.content += "\n+tampered\n"));
      await expectBlocked(run.id);
    });

    it("missing target-pass evidence on a REPAIR_VERIFIED run", async () => {
      SUITE_UNRELATED = UNRELATED;
      const { run } = await forgeFromInvestigation();
      mutate(run.id, (r) => delete r.verification.assessment.targetVerificationPassed);
      const res = await expectBlocked(run.id);
      expect(res.data.state).toBe("NOT_READY");
      expect(res.data.error).toMatch(/Target verification must pass/);
    });

    it("analyzed and execution commits that differ", async () => {
      const run = await verifiedRun();
      mutate(run.id, (r) => (r.source.executionCommitSha = STALE_SHA));
      await expectBlocked(run.id);
    });

    it("an investigation that is not the one bound to the run", async () => {
      const run = await verifiedRun();
      mutate(run.id, (r) => (r.investigationId = "inv-other"));
      await expectBlocked(run.id);
    });

    it("a repository that does not match the analyzed job", async () => {
      const run = await verifiedRun();
      mutate(run.id, (r) => (r.source.repoUrl = "https://github.com/someone-else/other.git"));
      await expectBlocked(run.id);
    });

    it("an unknown forgeRunId", async () => {
      await verifiedRun();
      await expectBlocked("forge-run-does-not-exist", 404);
    });

    it("a patch that git does not reproduce byte-for-byte", async () => {
      const run = await verifiedRun();
      ctx.diffOverride = "diff --git a/src/payments.ts b/src/payments.ts\n+something else\n";
      const res = await ship(run.id);
      expect(res.status).toBe(502);
      expect(res.data.error).toMatch(/does not match the verified canonical patch/i);
      expect(prRequests()).toHaveLength(0);
      expect(pushes()).toHaveLength(0);
      // Control: with an honest git the same run ships.
      ctx.diffOverride = null;
      expect((await ship(run.id)).status).toBe(200);
    });
  });
});
