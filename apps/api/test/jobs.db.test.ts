import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { analyzeRepository } from "@hubris/analyzer";
import { getDb, schema } from "@hubris/db";
import { app } from "../src/app";

// Deterministic fixture, real analyzer, real Postgres. Skipped wherever no
// DATABASE_URL is configured (e.g. environments without a database).
// In CI these run against the postgres service (see .github/workflows/ci.yml).
const FIXTURE = fileURLToPath(new URL("../../../fixtures/deep-chain", import.meta.url));
const hasDb = !!process.env.DATABASE_URL;
const createdIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  if (!db) return;
  for (const id of createdIds) {
    await db.delete(schema.jobs).where(eq(schema.jobs.id, id));
  }
});

describe.skipIf(!hasDb)("persisted job round-trip", () => {
  it("stores and returns the full twin the trace engine consumes", async () => {
    const db = getDb();
    expect(db).not.toBeNull();
    const twin = await analyzeRepository(FIXTURE);
    const id = crypto.randomUUID();
    createdIds.push(id);
    await db!.insert(schema.jobs).values({
      id,
      repoUrl: "test/deep-chain",
      status: "complete",
      result: {
        jobId: id,
        repository: { id: "r", name: "test/deep-chain", analysisStatus: "complete" },
        stats: {
          packages: twin.packages.length,
          functions: twin.functions.length,
          classes: twin.classes.length,
          endpoints: twin.endpoints.length,
          tests: twin.tests.length,
          relationships: twin.relationships.length,
          analysisMs: 0,
        },
        sample: { functions: [], endpoints: [] },
        full: {
          functions: twin.functions,
          classes: twin.classes,
          endpoints: twin.endpoints,
          tests: twin.tests,
          relationships: twin.relationships,
        },
      },
    });

    const res = await app.request(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
    const job = await res.json();

    // Frontend contract: the trace engine reads exactly these keys.
    for (const key of ["functions", "classes", "endpoints", "tests", "relationships"]) {
      expect(Array.isArray(job.result?.full?.[key])).toBe(true);
    }

    // Stored facts the trace depends on.
    const rels = job.result.full.relationships as Array<{ from: string; to: string; caller?: string }>;
    const has = (caller: string, to: string) =>
      rels.some((r) => r.caller === caller && r.to === to);
    expect(has("endpoint:GET:/start", "controller.begin")).toBe(true);
    expect(has("delta", "echo")).toBe(true);
    expect(has("delta", "zulu")).toBe(true);
    expect(has("delta", "require")).toBe(true);
    expect(has("foxtrot", "charlie")).toBe(true);
  });

  it("returns 404 for unknown job ids", async () => {
    const res = await app.request("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});
