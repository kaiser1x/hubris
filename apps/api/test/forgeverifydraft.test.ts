import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { DRAFT_PREVIEW_CHARS } from "../src/forgeverify";

// Deterministic coverage of the live-exercised Phase I rejection path:
// a Forge draft with no usable patch → HTTP 400 + bounded rejected-draft
// evidence, BEFORE any sandbox, git, or network use. Live model
// nondeterminism stays out of CI via module mocks + per-test drafts;
// the real parser still adjudicates every draft.
const store = vi.hoisted(() => ({
  draft: "After analysis, no patch is needed. All good.",
  jobUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
  lastUpdate: null as { result?: { draftRejections?: Array<Record<string, unknown>> } } | null,
}));

vi.mock("@hubris/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/llm")>();
  return {
    ...actual,
    chatComplete: vi.fn(async () => store.draft),
  };
});

const COMPLETE_JOB = {
  id: "00000000-0000-0000-0000-000000000000",
  repoUrl: "https://github.com/kaiser1x/ts-js-dummy.git",
  status: "complete",
  result: {
    repository: { name: "kaiser1x/ts-js-dummy" },
    stats: { functions: 1, classes: 0, endpoints: 0, tests: 0, relationships: 0 },
    full: { functions: [{ name: "alpha", path: "src/a.ts", line: 1 }] },
  },
  error: null,
};

vi.mock("@hubris/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hubris/db")>();
  return {
    ...actual,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: async () => [{ ...COMPLETE_JOB, repoUrl: store.jobUrl }],
        }),
      }),
      update: () => ({
        set: (v: typeof store.lastUpdate) => ({
          where: async () => {
            store.lastUpdate = v;
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
    runCommand: vi.fn(async () => {
      throw new Error("sandbox must not be touched on the reject path");
    }),
    uploadFile: vi.fn(async () => {
      throw new Error("sandbox must not be touched on the reject path");
    }),
  };
});

import { app } from "../src/app";
import { chatComplete, ModelError } from "@hubris/llm";
import { runCommand, uploadFile } from "@hubris/sandbox";

const MALFORMED_DIFF = "diff --git a/x b/x\n(no hunks here)";
const VALID_DIFF =
  "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

function stubCreds() {
  // Fake fixtures (never real secrets) so the handler reaches drafting.
  vi.stubEnv("NEBIUS_API_KEY", "k");
  vi.stubEnv("NEBIUS_PROJECT_ID", "p");
  vi.stubEnv("NEBIUS_MODEL", "m");
}

function rejections() {
  return store.lastUpdate?.result?.draftRejections ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  store.lastUpdate = null;
  store.draft = "After analysis, no patch is needed. All good.";
  store.jobUrl = "https://github.com/kaiser1x/ts-js-dummy.git";
});

async function postVerify(body: object) {
  return app.request("/api/forge-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: COMPLETE_JOB.id, ...body }),
  });
}

describe("POST /api/forge-verify draft rejection (mocked model)", () => {
  it("1. prose draft → 400 + bounded evidence + no sandbox calls", async () => {
    stubCreds();
    const res = await postVerify({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Forge produced no usable patch",
      status: 400,
    });
    expect(chatComplete).toHaveBeenCalledOnce();
    expect(chatComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ maxTokens: 8192 })
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    const [entry] = rejections();
    expect(entry.draftRejected).toBe(true);
    expect(entry.reason).toBe("no usable patch");
    expect(entry.draftPreview).toContain("no patch is needed");
  });

  it("2. malformed diff → 400 + bounded evidence + no sandbox calls", async () => {
    stubCreds();
    store.draft = MALFORMED_DIFF;
    const res = await postVerify({});
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(1);
  });

  it("3. valid diff sails past extraction (reaches staging, not rejection)", async () => {
    stubCreds();
    store.draft = "```diff\n" + VALID_DIFF + "\n```";
    // Point at a nonexistent repo: the run must proceed PAST the
    // no-usable-patch gate and fail later at staging (fast 404) — proving
    // a valid diff is not rejected. No sandbox use either way.
    store.jobUrl = "https://github.com/kaiser1x/hubris-no-such-repo.git";
    const res = await postVerify({});
    const body = await res.json();
    expect(body.error ?? "").not.toContain("no usable patch");
    expect(rejections()).toHaveLength(0);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("4. truncation cannot exceed the defined bound", async () => {
    stubCreds();
    store.draft = "z".repeat(5000);
    const res = await postVerify({});
    expect(res.status).toBe(400);
    const [entry] = rejections();
    expect((entry.draftPreview as string).length).toBeLessThanOrEqual(DRAFT_PREVIEW_CHARS);
    expect((entry.draftPreview as string).length).toBeGreaterThan(0);
  });

  it("5. secret-like content is scrubbed, never persisted raw", async () => {
    stubCreds();
    store.draft =
      "no patch here, but note NEBIUS_API_KEY=abc123 and Bearer xyz-token-9 end";
    const res = await postVerify({});
    expect(res.status).toBe(400);
    const [entry] = rejections();
    const preview = entry.draftPreview as string;
    expect(preview).toContain("NEBIUS_API_KEY=<redacted>");
    expect(preview).toContain("Bearer <redacted>");
    expect(preview).not.toContain("abc123");
    expect(preview).not.toContain("xyz-token-9");
  });

  it("6. model empty response → deterministic 502 + no sandbox calls", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockRejectedValueOnce(
      new ModelError("empty", "Model API returned no content")
    );
    const res = await postVerify({});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Model request failed", status: 502 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    // Nothing to persist: no draft, no execution.
    expect(rejections()).toHaveLength(0);
  });

  it("7. model timeout settles the request (502, no hang, no sandbox)", async () => {
    stubCreds();
    vi.mocked(chatComplete).mockRejectedValueOnce(
      new ModelError("timeout", "Model request timed out")
    );
    const t0 = Date.now();
    const res = await postVerify({});
    expect(Date.now() - t0).toBeLessThan(30000);
    expect(res.status).toBe(502);
    expect(runCommand).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(rejections()).toHaveLength(0);
  });
});
