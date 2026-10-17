import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

// Full handler coverage without network or sandbox: the twin job and model
// drafts are mocked, staging is pointed at a local fixture git repo, and
// the sandbox client throws if touched. Real git + real validator logic;
// everything else hermetic.
const store = vi.hoisted(() => ({
  draftPlan: "",
  jobRef: undefined as string | undefined,
  investigationRuns: [] as Array<Record<string, unknown>>,
  cloneCalls: [] as Array<{ url: string; ref: string | undefined }>,
  updates: [] as Array<{
    result?: {
      forgeRuns?: Array<Record<string, unknown>>;
      draftRejections?: Array<Record<string, unknown>>;
    };
  }>,
}));

const FIXTURE = { dir: "", tar: "" };

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return {
    ...actual,
    chatComplete: vi.fn(async () => store.draftPlan),
  };
});

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  const job = () => ({
    id: "00000000-0000-0000-0000-000000000000",
    repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
    status: "complete",
    result: {
      repository: { name: "kaiser1x/ts-js-dummy" },
      ...(store.jobRef ? { ref: store.jobRef } : {}),
      stats: { functions: 1, classes: 0, endpoints: 0, tests: 0, relationships: 0 },
      full: { functions: [{ name: "x", path: "src/a.ts", line: 1 }] },
      ...(store.investigationRuns.length > 0 ? { investigationRuns: store.investigationRuns } : {}),
    },
    error: null,
  });
  return {
    ...actual,
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [job()] }) }),
      update: () => ({
        set: (v: { result?: { forgeRuns?: Array<Record<string, unknown>> } }) => ({
          where: async () => {
            store.updates.push(v);
          },
        }),
      }),
    }),
  };
});

vi.mock("@hubris/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/sandbox")>();
  const boom = async () => {
    throw new Error("sandbox must not be touched on invalid-edit paths");
  };
  return { ...actual, runCommand: vi.fn(boom), uploadFile: vi.fn(boom) };
});

vi.mock("../src/checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkout")>();
  return {
    ...actual,
    cloneAndArchive: async (url: string, ref: string | undefined) => {
      store.cloneCalls.push({ url, ref });
      return {
        src: FIXTURE.dir,
        tarPath: FIXTURE.tar,
        tracked: ["src/a.ts", "package.json", "pnpm-lock.yaml"],
        commitSha: "2".repeat(40),
      };
    },
  };
});

import { app } from "../src/app";
import { chatComplete } from "@hubris/llm";
import { runCommand, uploadFile } from "@hubris/sandbox";

function stubCreds() {
  vi.stubEnv("NEBIUS_API_KEY", "k");
  vi.stubEnv("NEBIUS_PROJECT_ID", "p");
  vi.stubEnv("NEBIUS_MODEL", "m");
}

function lastRun(): Record<string, unknown> {
  const updates = store.updates;
  const runs = updates[updates.length - 1]?.result?.forgeRuns ?? [];
  return runs[runs.length - 1] as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeAll(async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-structured-ep-"));
  FIXTURE.dir = dir;
  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write("src/a.ts", "foo();\nfoo();\n");
  write("package.json", JSON.stringify({ scripts: { test: "echo ok" } }));
  const opts = { cwd: dir, timeout: 30000 };
  await exec("git", ["init", "-q"], opts);
  await exec("git", ["config", "user.email", "t@t"], opts);
  await exec("git", ["config", "user.name", "t"], opts);
  await exec("git", ["add", "-A"], opts);
  await exec("git", ["commit", "-qm", "base"], opts);
  FIXTURE.tar = path.join(dir, "repo.tar");
  fs.writeFileSync(FIXTURE.tar, "dummy-tarball-bytes");
});

afterAll(async () => {
  if (FIXTURE.dir) await fs.promises.rm(FIXTURE.dir, { recursive: true, force: true });
});

function plan(edits: unknown[]): string {
  return JSON.stringify({ edits });
}

async function postStructured(body: object) {
  return app.request("/api/forge-structured", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000", ...body }),
  });
}

function readyInvestigation(id: string, targetFn: string): Record<string, unknown> {
  return {
    investigationId: id,
    jobId: "00000000-0000-0000-0000-000000000000",
    focus: `Target: ${targetFn} (src/a.ts)`,
    status: "READY",
    createdAt: new Date().toISOString(),
    plan: {
      summary: `target ${targetFn}`,
      target: { file: "src/a.ts", function: targetFn },
      currentBehavior: "current behavior",
      expectedBehavior: "expected behavior",
      repairContract: {
        requiredOutcome: "must throw",
        preserveBehavior: [],
        relevantCondition: "condition",
        relevantOperation: "operation",
        existingErrorContract: "error",
        minimalRepairDescription: "repair",
        setupFacts: ["setup"],
        actionFacts: ["action()"],
        observedFacts: ["observed"],
        expectedFacts: ["expect(result).toBe(expected)"],
        sourceEvidence: ["if (condition)", "store.items.delete(id)"],
        relevantAssertions: ["expect(result).toBe(expected)"],
        conditionOperationAreDistinct: true,
      },
      constraints: [],
      evidence: ["evidence"],
      confidence: "high" as const,
    },
  };
}

describe("POST /api/forge-structured (mocked model, fixture repo)", () => {
  it("zero-match plan → EDIT_CONTEXT_MISMATCH terminal, no sandbox", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", function: "x", oldText: "missing();", newText: "y();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect(run.verified).toBe(false);
    expect(run.verification).toBeNull();
    const generation = run.generation as Record<string, unknown>;
    expect(generation.format).toBe("structured-edit");
    expect((generation.edits as Array<Record<string, unknown>>)[0].path).toBe("src/a.ts");
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    // Bounded byte-mismatch diagnostic: fixture src/a.ts is "foo();\nfoo();\n"
    // (14 bytes).
    const mismatch = run.mismatch as Record<string, unknown>;
    expect(mismatch.oldTextLength).toBe("missing();".length);
    expect(mismatch.sourceLength).toBe("foo();\nfoo();\n".length);
    expect(mismatch.matchingPrefixChars).toBe(0);
    expect(mismatch.sourceOffset).toBe(-1);
    expect(typeof mismatch.oldTextSnippet).toBe("string");
    expect(String(mismatch.oldTextSnippet).length).toBeLessThanOrEqual(240);
  });

  it("CRLF-normalized oldText against LF source still fails closed", async () => {
    stubCreds();
    // The authoritative fixture is LF ("foo();\nfoo();\n"). A model oldText
    // with CRLF line endings must NOT be normalized into a match.
    store.draftPlan = plan([
      { path: "src/a.ts", oldText: "foo();\r\nfoo();", newText: "bar();\r\nbar();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    const mismatch = run.mismatch as Record<string, unknown>;
    // "foo();" matches; the CRLF ending diverges from the LF source.
    expect(mismatch.matchingPrefixChars).toBe(6);
    expect(mismatch.sourceLength).toBe("foo();\nfoo();\n".length);
  });

  it("ambiguous plan → AMBIGUOUS_EDIT terminal, file untouched, no sandbox", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", oldText: "foo();", newText: "bar();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(lastRun().status).toBe("AMBIGUOUS_EDIT");
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("traversal and untracked paths → PATH_REJECTED, no sandbox", async () => {
    stubCreds();
    for (const bad of ["../evil.ts", "src/missing.ts"]) {
      store.draftPlan = plan([{ path: bad, oldText: "x", newText: "y" }]);
      const res = await postStructured({ focus: "do things" });
      expect(res.status).toBe(200);
      const run = lastRun();
      expect(run.status).toBe("PATH_REJECTED");
      expect((run as Record<string, unknown>).verification).toBeNull();
    }
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("malformed model output → 400 + bounded rejection evidence, no sandbox", async () => {
    stubCreds();
    store.draftPlan = "not json at all, NEBIUS_API_KEY=abc123";
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Malformed edit plan", status: 400 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    const update = store.updates[store.updates.length - 1];
    const [entry] = update.result?.draftRejections ?? [];
    expect(entry.draftRejected).toBe(true);
    expect(entry.reason).toBe("malformed edit plan");
    expect((entry.draftPreview as string).length).toBeLessThanOrEqual(2000);
    expect(entry.draftPreview).toContain("NEBIUS_API_KEY=<redacted>");
    expect(entry.draftPreview).not.toContain("abc123");
    expect(update.result?.forgeRuns ?? []).toHaveLength(0);
  });

  it("schema-invalid plan → 400 + bounded rejection evidence, no sandbox", async () => {
    stubCreds();
    store.draftPlan = JSON.stringify({ edits: [{ path: "src/a.ts" }] });
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid edit plan", status: 400 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    const update = store.updates[store.updates.length - 1];
    const [entry] = update.result?.draftRejections ?? [];
    expect(entry.reason).toBe("invalid edit plan");
  });

  it("valid plan sails past local gates into staging (upload attempted)", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", oldText: "foo();\nfoo();", newText: "bar();\nbar();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    // Upload is mocked to throw: 502 proves the valid plan cleared every
    // local gate (schema, paths, exact match) and reached staging.
    expect(res.status).toBe(502);
    expect(uploadFile).toHaveBeenCalled();
  });
});

describe("POST /api/forge-structured investigation binding (mocked model, fixture repo)", () => {
  const INV_A = "00000000-0000-0000-0000-00000000000a";
  const INV_B = "00000000-0000-0000-0000-00000000000b";
  const INV_AMB = "00000000-0000-0000-0000-00000000000c";
  const INV_MISSING = "00000000-0000-0000-0000-0000000000ff";

  beforeEach(() => {
    store.investigationRuns = [readyInvestigation(INV_A, "alpha"), readyInvestigation(INV_B, "beta")];
  });
  afterEach(() => {
    store.investigationRuns = [];
  });

  it("loads the exact READY investigation and derives focus from its plan", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", function: "x", oldText: "missing();", newText: "y();" },
    ]);
    const res = await postStructured({ focus: "client focus text", investigationId: INV_B });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    const gen = run.generation as Record<string, unknown>;
    // The focus is derived from INV_B's plan (target beta), NOT the client
    // focus text.
    expect(String(gen.focus)).toContain("beta");
    expect(String(gen.focus)).not.toContain("client focus");
    expect(run.investigationId).toBe(INV_B);
  });

  it("does not accidentally load another investigation for the same job", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", function: "x", oldText: "missing();", newText: "y();" },
    ]);
    // Request the OLDER investigation; the newest is INV_B.
    const res = await postStructured({ focus: "x", investigationId: INV_A });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(String((run.generation as Record<string, unknown>).focus)).toContain("alpha");
    expect(run.investigationId).toBe(INV_A);
  });

  it("fails clearly when the investigation is missing", async () => {
    stubCreds();
    store.draftPlan = plan([]);
    const res = await postStructured({ focus: "x", investigationId: INV_MISSING });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Investigation ${INV_MISSING} not found on this job`,
      status: 400,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails clearly when the investigation is not READY", async () => {
    stubCreds();
    store.investigationRuns = [
      { investigationId: INV_AMB, status: "AMBIGUOUS", plan: null, message: "no match" },
    ];
    const res = await postStructured({ focus: "x", investigationId: INV_AMB });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Investigation is not READY for Forge",
      status: 400,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("requests without an investigation keep working (legacy / direct API)", async () => {
    stubCreds();
    store.investigationRuns = [];
    store.draftPlan = plan([
      { path: "src/a.ts", oldText: "foo();\nfoo();", newText: "bar();\nbar();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(502); // cleared local gates; upload (mocked) throws
    expect(uploadFile).toHaveBeenCalled();
  });
});

describe("POST /api/forge-structured source revision (mocked clone/sandbox)", () => {
  const JOB_REF = "hubris/buggy-idempotency";
  const COMMIT = "2".repeat(40);
  const CANON = "a".repeat(64);
  const MATCHING_PLAN = plan([
    { path: "src/a.ts", oldText: "foo();\nfoo();", newText: "bar();\nbar();" },
  ]);
  const MISSING_PLAN = plan([
    { path: "src/a.ts", oldText: "missing();", newText: "y();" },
  ]);

  async function tarSha(): Promise<string> {
    const { createHash } = await import("crypto");
    return createHash("sha256").update("dummy-tarball-bytes").digest("hex");
  }

  function sandboxSuccess(stdout: string) {
    return vi.mocked(runCommand).mockResolvedValueOnce({
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
  }

  // Reset hooks for this block: hermetic per test, no leakage into the
  // shared boom defaults relied upon by earlier describes.
  beforeEach(async () => {
    store.jobRef = undefined;
    store.cloneCalls = [];
    store.updates = [];
    vi.mocked(runCommand).mockReset();
    vi.mocked(uploadFile).mockReset();
    const sha = await tarSha();
    vi.mocked(uploadFile).mockImplementation(async () => ({ uuid: "u", sha256: sha }));
  });

  it("1. job ref flows to checkout when the caller omits ref", async () => {
    stubCreds();
    store.jobRef = JOB_REF;
    store.draftPlan = MISSING_PLAN;
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(store.cloneCalls.at(-1)).toEqual({
      url: "https://github.com/kaiser1x/ts-js-dummy.git",
      ref: JOB_REF,
    });
    expect(lastRun().status).toBe("EDIT_CONTEXT_MISMATCH");
  });

  it("2. explicit caller ref overrides the job ref", async () => {
    stubCreds();
    store.jobRef = JOB_REF;
    store.draftPlan = MISSING_PLAN;
    const res = await postStructured({ focus: "do things", ref: "main" });
    expect(res.status).toBe(200);
    expect(store.cloneCalls.at(-1)?.ref).toBe("main");
  });

  it("3. legacy job without ref keeps default-branch checkout + explicit evidence", async () => {
    stubCreds();
    store.draftPlan = MISSING_PLAN;
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(store.cloneCalls.at(-1)?.ref).toBeUndefined();
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect(run.source).toMatchObject({ ref: null, commitSha: COMMIT });
  });

  it("4. sandbox revision mismatch stops before patch attribution", async () => {
    stubCreds();
    store.jobRef = JOB_REF;
    store.draftPlan = MATCHING_PLAN;
    sandboxSuccess(
      ["EDIT_OK 1", `CANONICAL_SHA ${CANON} 10`, `SOURCE_REF main`, `SOURCE_SHA ${COMMIT}`, "PATCH_OK", "VERIFY_BEGIN"].join("\n")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("SOURCE_MISMATCH");
    expect(run.apply).toEqual({ applied: false });
    expect(run.verification).toBeNull();
    expect(run.sandboxSource).toMatchObject({ ref: "main", matched: false });
    expect(run.verified).toBe(false);
  });

  it("5. matching revision carries full source evidence on success", async () => {
    stubCreds();
    store.jobRef = JOB_REF;
    store.draftPlan = MATCHING_PLAN;
    sandboxSuccess(
      ["EDIT_OK 1", `CANONICAL_SHA ${CANON} 10`, `SOURCE_REF ${JOB_REF}`, `SOURCE_SHA ${COMMIT}`, "PATCH_OK", "VERIFY_BEGIN"].join("\n")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("VERIFIED");
    expect(run.source).toMatchObject({ ref: JOB_REF, refSource: "job", commitSha: COMMIT });
    expect(run.sandboxSource).toMatchObject({ ref: JOB_REF, sha: COMMIT, matched: true });
  });

  it("6. each run keeps its own revision", async () => {
    stubCreds();
    store.draftPlan = MISSING_PLAN;
    store.jobRef = "hubris/buggy-idempotency";
    await postStructured({ focus: "first" });
    store.jobRef = "main";
    await postStructured({ focus: "second" });
    const runs = store.updates.flatMap((u) => u.result?.forgeRuns ?? []);
    expect(runs).toHaveLength(2);
    expect((runs[0] as Record<string, unknown>).source).toMatchObject({
      ref: "hubris/buggy-idempotency",
    });
    expect((runs[1] as Record<string, unknown>).source).toMatchObject({ ref: "main" });
  });

  it("7. persists the EXACT canonical patch content with matching sha and byte count", async () => {
    stubCreds();
    const { createHash } = await import("crypto");
    store.draftPlan = MATCHING_PLAN;
    const content =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-foo();\n-foo();\n+bar();\n+bar();\n";
    const sha = createHash("sha256").update(content).digest("hex");
    const bytes = Buffer.byteLength(content, "utf-8");
    const b64 = Buffer.from(content, "utf-8").toString("base64");
    sandboxSuccess(
      [
        "EDIT_OK 1",
        `CANONICAL_SHA ${sha} ${bytes}`,
        `CANONICAL_B64 ${b64}`,
        `SOURCE_REF ${JOB_REF}`,
        `SOURCE_SHA ${COMMIT}`,
        "PATCH_OK",
        "VERIFY_BEGIN",
      ].join("\n")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    // The persisted patch is byte-for-byte the canonical diff, with its sha and byte count.
    expect(lastRun().canonicalPatch).toEqual({ sha, bytes, content });
  });

  it("8. withholds canonical patch content when the sha does not match (fail closed)", async () => {
    stubCreds();
    store.draftPlan = MATCHING_PLAN;
    const content = "diff --git a/x b/x\n--- a/x\n+++ b/x\n";
    const b64 = Buffer.from(content, "utf-8").toString("base64");
    sandboxSuccess(
      [
        "EDIT_OK 1",
        `CANONICAL_SHA ${CANON} ${Buffer.byteLength(content, "utf-8")}`,
        `CANONICAL_B64 ${b64}`,
        `SOURCE_REF ${JOB_REF}`,
        `SOURCE_SHA ${COMMIT}`,
        "PATCH_OK",
        "VERIFY_BEGIN",
      ].join("\n")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const cp = lastRun().canonicalPatch as Record<string, unknown>;
    expect(cp.sha).toBe(CANON);
    // sha256(content) !== sha → content is not persisted.
    expect(cp.content).toBeUndefined();
  });
});

describe("POST /api/forge-structured model failure classes (mocked model)", () => {
  // Failure-class taxonomy for the draft stage: every class maps
  // deterministically without sandbox use and without loosening validation.
  // chatComplete-only failures (any ModelError kind) → 502; unparsable
  // output → 400 malformed; schema rule violations → 400 invalid.
  beforeEach(async () => {
    store.jobRef = undefined;
    store.cloneCalls = [];
    store.updates = [];
    vi.mocked(runCommand).mockReset();
    vi.mocked(uploadFile).mockReset();
  });

  it("model empty response → 502, no sandbox, no run, no rejection entry", async () => {
    stubCreds();
    const { ModelError } = await import("@hubris/llm");
    vi.mocked(chatComplete).mockRejectedValueOnce(
      new ModelError("empty", "Model API returned no content")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Model request failed", status: 502 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(store.updates).toHaveLength(0);
  });

  it("model transport failure → 502, no sandbox", async () => {
    stubCreds();
    const { ModelError } = await import("@hubris/llm");
    vi.mocked(chatComplete).mockRejectedValueOnce(
      new ModelError("transport", "Model transport error: fetch failed")
    );
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(502);
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("prose response → 400 malformed (distinct from schema failure)", async () => {
    stubCreds();
    store.draftPlan = "After analysis, no patch is needed. All good.";
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Malformed edit plan", status: 400 });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("oldText === newText → 400 invalid (schema holds, not loosened)", async () => {
    stubCreds();
    store.draftPlan = plan([
      { path: "src/a.ts", oldText: "foo();", newText: "foo();" },
    ]);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid edit plan", status: 400 });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("POST /api/forge-structured failure taxonomy (no-edit, timeouts, sandbox, budget)", () => {
  // Each failure class gets its own status + code so the UI can say what
  // actually happened. None of them becomes a success, and none before the
  // sandbox stage touches the sandbox.
  const COMMIT = "2".repeat(40);
  const MATCHING_PLAN = plan([
    { path: "src/a.ts", oldText: "foo();\nfoo();", newText: "bar();\nbar();" },
  ]);

  beforeEach(async () => {
    store.jobRef = undefined;
    store.cloneCalls = [];
    store.updates = [];
    vi.mocked(chatComplete).mockClear();
    vi.mocked(runCommand).mockReset();
    vi.mocked(uploadFile).mockReset();
    const { createHash } = await import("crypto");
    const sha = createHash("sha256").update("dummy-tarball-bytes").digest("hex");
    vi.mocked(uploadFile).mockImplementation(async () => ({ uuid: "u", sha256: sha }));
  });

  it("empty edit plan (model proposes no change) → 422 NO_EDIT_PROPOSED with the revision, no sandbox", async () => {
    // Reproduces the production failure: job analyzed on main (defect absent),
    // the model answered {"edits": []}, and the endpoint said "Invalid edit plan".
    stubCreds();
    store.draftPlan = JSON.stringify({ edits: [] });
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(422);
    const data = (await res.json()) as { error: string; code: string };
    expect(data.code).toBe("NO_EDIT_PROPOSED");
    expect(data.error).not.toBe("Invalid edit plan");
    expect(data.error).toContain(`default branch @ ${COMMIT.slice(0, 7)}`);
    expect(data.error).toMatch(/Reproduce/);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    const update = store.updates[store.updates.length - 1];
    expect(update.result?.draftRejections?.[0].reason).toBe("no edit proposed");
    expect(update.result?.forgeRuns ?? []).toHaveLength(0);
  });

  it("an edit plan with edits that are invalid is still 400 Invalid edit plan (validation not loosened)", async () => {
    stubCreds();
    store.draftPlan = JSON.stringify({ edits: [{ path: "src/a.ts" }] });
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid edit plan", status: 400 });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("model timeout → 504 MODEL_TIMEOUT, not a validation error, no sandbox, nothing persisted", async () => {
    stubCreds();
    const { ModelError } = await import("@hubris/llm");
    vi.mocked(chatComplete).mockRejectedValueOnce(new ModelError("timeout", "Model request timed out"));
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(504);
    const data = (await res.json()) as { error: string; code: string };
    expect(data.code).toBe("MODEL_TIMEOUT");
    expect(data.error).not.toMatch(/edit plan$/);
    expect(data.error).toMatch(/no sandbox run started/);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(store.updates).toHaveLength(0);
  });

  it("the model call is always given an abort signal", async () => {
    stubCreds();
    store.draftPlan = JSON.stringify({ edits: [] });
    await postStructured({ focus: "do things" });
    const options = vi.mocked(chatComplete).mock.calls[0][2] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("sandbox upload failure → 502 SANDBOX_UPLOAD_FAILED (distinct from model/validation)", async () => {
    stubCreds();
    store.draftPlan = MATCHING_PLAN;
    vi.mocked(uploadFile).mockReset();
    vi.mocked(uploadFile).mockRejectedValue(new Error("upload 500"));
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("SANDBOX_UPLOAD_FAILED");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("sandbox poll deadline → 504 SANDBOX_TIMEOUT; other run errors → 502 SANDBOX_RUN_FAILED", async () => {
    stubCreds();
    store.draftPlan = MATCHING_PLAN;
    const { SANDBOX_WAIT_TIMEOUT_MESSAGE } = await import("@hubris/sandbox");
    vi.mocked(runCommand).mockRejectedValueOnce(new Error(SANDBOX_WAIT_TIMEOUT_MESSAGE));
    const timedOut = await postStructured({ focus: "do things" });
    expect(timedOut.status).toBe(504);
    expect(((await timedOut.json()) as { code: string }).code).toBe("SANDBOX_TIMEOUT");

    vi.mocked(runCommand).mockRejectedValueOnce(new Error("instance crashed"));
    const failed = await postStructured({ focus: "do things" });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { code: string }).code).toBe("SANDBOX_RUN_FAILED");
  });

  it("a valid plan still reaches the sandbox stage and verifies", async () => {
    stubCreds();
    store.draftPlan = MATCHING_PLAN;
    vi.mocked(runCommand).mockResolvedValueOnce({
      exitCode: 0,
      stdout: ["EDIT_OK 1", `CANONICAL_SHA ${"a".repeat(64)} 10`, "SOURCE_REF ", `SOURCE_SHA ${COMMIT}`, "PATCH_OK", "VERIFY_BEGIN"].join("\n"),
      stderr: "",
      timedOut: false,
    });
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("with a configured function budget, the sandbox run is clamped to it", async () => {
    stubCreds();
    vi.stubEnv("HUBRIS_FUNCTION_MAX_DURATION_S", "285");
    store.draftPlan = MATCHING_PLAN;
    vi.mocked(runCommand).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    await postStructured({ focus: "do things" });
    const req = vi.mocked(runCommand).mock.calls[0][1] as { waitMs: number; timeout: number };
    // 285s budget − 15s reserve: the poll never outlives the request, and the
    // command is killed server-side before the poll gives up.
    expect(req.waitMs).toBeLessThanOrEqual(270_000);
    expect(req.timeout * 1000).toBeLessThan(req.waitMs);
  });

  it("too little budget left → 504 BUDGET_EXHAUSTED before any upload", async () => {
    stubCreds();
    vi.stubEnv("HUBRIS_FUNCTION_MAX_DURATION_S", "60");
    store.draftPlan = MATCHING_PLAN;
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { code: string }).code).toBe("BUDGET_EXHAUSTED");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("POST /api/forge-structured single informed redraft on a byte-exact mismatch", () => {
  // Fixture src/a.ts is "foo();\nfoo();\n". A mis-indented oldText is the
  // production failure shape (the model retyped the code instead of copying).
  const MISINDENTED = plan([{ path: "src/a.ts", oldText: "foo();\n foo();", newText: "bar();\nbar();" }]);
  const EXACT = plan([{ path: "src/a.ts", oldText: "foo();\nfoo();", newText: "bar();\nbar();" }]);
  const COMMIT = "2".repeat(40);

  beforeEach(async () => {
    store.jobRef = undefined;
    store.updates = [];
    vi.mocked(chatComplete).mockReset();
    vi.mocked(runCommand).mockReset();
    vi.mocked(uploadFile).mockReset();
    const { createHash } = await import("crypto");
    const sha = createHash("sha256").update("dummy-tarball-bytes").digest("hex");
    vi.mocked(uploadFile).mockImplementation(async () => ({ uuid: "u", sha256: sha }));
    vi.mocked(runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: ["EDIT_OK 1", `CANONICAL_SHA ${"a".repeat(64)} 10`, "SOURCE_REF ", `SOURCE_SHA ${COMMIT}`, "PATCH_OK", "VERIFY_BEGIN"].join("\n"),
      stderr: "",
      timedOut: false,
    });
  });

  const prompts = () => vi.mocked(chatComplete).mock.calls.map((call) => (call[1] as Array<{ content: string }>)[1].content);

  it("redrafts once with the exact source lines; a corrected plan passes the same byte-exact gate and reaches the sandbox", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockResolvedValueOnce(MISINDENTED).mockResolvedValueOnce(EXACT);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalledTimes(2);
    const retryPrompt = prompts()[1];
    expect(retryPrompt.startsWith(prompts()[0])).toBe(true);
    expect(retryPrompt).toContain("only its first 7 characters match");
    expect(retryPrompt).toContain(JSON.stringify("foo();\nfoo();\n"));
    expect(uploadFile).toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    const run = lastRun();
    expect(run.status).toBe("VERIFIED");
    const generation = run.generation as { retry: Record<string, unknown>; edits: Array<{ oldTextHash: string }> };
    expect(generation.retry.outcome).toBe("accepted");
    expect((generation.retry.firstAttempt as { mismatch: { matchingPrefixChars: number } }).mismatch.matchingPrefixChars).toBe(7);
    const { createHash } = await import("crypto");
    expect(generation.edits[0].oldTextHash).toBe(createHash("sha256").update("foo();\nfoo();").digest("hex"));
  });

  it("a second mismatch fails closed: EDIT_CONTEXT_MISMATCH, exactly two model calls, no sandbox", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockResolvedValue(MISINDENTED);
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    expect(chatComplete).toHaveBeenCalledTimes(2);
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect(run.verified).toBe(false);
    expect((run.generation as { retry: { outcome: string } }).retry.outcome).toBe("EDIT_CONTEXT_MISMATCH");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("other local rejections are not retried (ambiguous, path)", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockResolvedValue(plan([{ path: "src/a.ts", oldText: "foo();", newText: "bar();" }]));
    await postStructured({ focus: "do things" });
    expect(lastRun().status).toBe("AMBIGUOUS_EDIT");
    expect(chatComplete).toHaveBeenCalledTimes(1);

    vi.mocked(chatComplete).mockReset();
    vi.mocked(chatComplete).mockResolvedValue(plan([{ path: "src/untracked.ts", oldText: "x", newText: "y" }]));
    await postStructured({ focus: "do things" });
    expect(lastRun().status).toBe("PATH_REJECTED");
    expect(chatComplete).toHaveBeenCalledTimes(1);
  });

  it("a redraft that fails to parse keeps the first rejection (no sandbox) and records why", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockResolvedValueOnce(MISINDENTED).mockResolvedValueOnce("not json");
    await postStructured({ focus: "do things" });
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect((run.mismatch as { matchingPrefixChars: number }).matchingPrefixChars).toBe(7);
    expect((run.generation as { retry: { outcome: string } }).retry.outcome).toBe("malformed");
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("a redraft that times out keeps the first rejection, not a misleading timeout success", async () => {
    stubCreds();
    const { ModelError } = await import("@hubris/llm");
    vi.mocked(chatComplete).mockResolvedValueOnce(MISINDENTED).mockRejectedValueOnce(new ModelError("timeout", "Model request timed out"));
    const res = await postStructured({ focus: "do things" });
    expect(res.status).toBe(200);
    const run = lastRun();
    expect(run.status).toBe("EDIT_CONTEXT_MISMATCH");
    expect((run.generation as { retry: { outcome: string } }).retry.outcome).toBe("timeout");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("no redraft when the request budget cannot fit another model call plus the sandbox", async () => {
    stubCreds();
    // 100s budget − 15s reserve = 85s left: enough for the sandbox (60s), not
    // for a redraft (60s + 30s).
    vi.stubEnv("HUBRIS_FUNCTION_MAX_DURATION_S", "100");
    vi.mocked(chatComplete).mockResolvedValue(MISINDENTED);
    await postStructured({ focus: "do things" });
    expect(chatComplete).toHaveBeenCalledTimes(1);
    expect(lastRun().status).toBe("EDIT_CONTEXT_MISMATCH");
    expect((lastRun().generation as { retry?: unknown }).retry).toBeUndefined();
  });
});
