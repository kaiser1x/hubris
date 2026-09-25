import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/app";
import {
  buildCheckoutScript,
  isTransferExcluded,
  limitsFromEnv,
  parseCheckoutListing,
  DEFAULT_CHECKOUT_LIMITS,
} from "../src/checkout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/checkout validation", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await app.request("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 without jobId", async () => {
    const res = await app.request("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsafe ref", async () => {
    const res = await app.request("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: "00000000-0000-0000-0000-000000000000",
        ref: "bad;rm -rf",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no DATABASE_URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await app.request("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("isTransferExcluded", () => {
  it.each([".env", "config/.env", ".env.local", ".env.production", "tls/key.pem", "id.key"])(
    "excludes %s",
    (p) => {
      expect(isTransferExcluded(p)).toBe(true);
    }
  );

  it.each([".env.example", "src/index.ts", "package.json", ".gitignore", "docs/keys.md"])(
    "keeps %s",
    (p) => {
      expect(isTransferExcluded(p)).toBe(false);
    }
  );
});

describe("limitsFromEnv", () => {
  it("returns conservative defaults", () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_CHECKOUT_LIMITS);
    expect(limitsFromEnv({ HUBRIS_MAX_REPO_FILES: "nope", HUBRIS_MAX_REPO_BYTES: "-5" })).toEqual(
      DEFAULT_CHECKOUT_LIMITS
    );
  });

  it("honors overrides", () => {
    expect(
      limitsFromEnv({ HUBRIS_MAX_REPO_FILES: "100", HUBRIS_MAX_REPO_BYTES: "1000" })
    ).toEqual({ maxFiles: 100, maxBytes: 1000 });
  });
});

describe("buildCheckoutScript", () => {
  it("extracts the tarball and reports a bounded manifest", () => {
    const cmd = buildCheckoutScript([]);
    expect(cmd).toContain("tar -xf '/tmp/hubris-upload/repo.tar'");
    expect(cmd).toContain("cd '/tmp/hubris-repo'");
    expect(cmd).toContain("head -100");
    expect(cmd).toContain("COUNT");
    expect(cmd).not.toContain("rm -f");
  });

  it("quote-escapes excluded paths", () => {
    const cmd = buildCheckoutScript([".env", "we'ird/key.pem"]);
    expect(cmd).toContain("rm -f '.env' 'we'\\''ird/key.pem'");
  });
});

describe("parseCheckoutListing", () => {
  it("extracts the remote file count", () => {
    const out = parseCheckoutListing("FILES_BEGIN\n./a\nFILES_END\nCOUNT 12\n");
    expect(out.count).toBe(12);
  });

  it("returns null count when the marker is missing", () => {
    expect(parseCheckoutListing("boom").count).toBeNull();
  });
});
