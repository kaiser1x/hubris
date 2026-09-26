import { describe, it, expect } from "vitest";
import { closeDb, getDb } from "@hubris/db";

// closeDb lets short-lived processes (diagnostics, scripts) exit instead
// of lingering on open pool sockets. Production servers never call it.
describe("closeDb", () => {
  it("resolves cleanly with nothing open", async () => {
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it.skipIf(!process.env.DATABASE_URL)("resets the singleton", async () => {
    expect(getDb()).not.toBeNull();
    await closeDb();
    expect(getDb()).not.toBeNull();
  });
});
