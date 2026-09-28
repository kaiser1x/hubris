import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard: production web source must never contain the original
// demo repository's identifiers. Test fixtures may keep them, so only
// apps/web/app production code is scanned.
const APP_ROOT = fileURLToPath(new URL("../app", import.meta.url));

const FORBIDDEN = [
  "ts-js-dummy",
  "kaiser1x",
  "case-031",
  "buggy-idempotency",
  "createPayment",
  "transactions.ts",
  "hubris-demo-ledger",
  "payments.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".next" || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("no demo repository references in production web source", () => {
  const files = walk(APP_ROOT);

  it("scanned at least the workspace pages", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("contains no hardcoded demo identifiers", () => {
    const hits = files.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      const found = FORBIDDEN.filter((token) => content.includes(token));
      return found.map((token) => `${file.replace(APP_ROOT, "app")}: ${token}`);
    });
    expect(hits).toEqual([]);
  });
});