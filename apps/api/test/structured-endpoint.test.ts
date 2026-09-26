import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
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
      stats: { functions: 1, classes: 0, endpoints: 0, tests: 0, relationships: 0 },
      full: { functions: [{ name: "x", path: "src/a.ts", line: 1 }] },
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
    cloneAndArchive: async () => ({
      src: FIXTURE.dir,
      tarPath: FIXTURE.tar,
      tracked: ["src/a.ts", "package.json"],
    }),
  };
});

import { app } from "../src/app";
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
