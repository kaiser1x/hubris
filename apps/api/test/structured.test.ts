import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  EditPlanSchema,
  isSupportedEditPath,
  buildSourceExcerpts,
  buildStructuredScript,
  parseStructuredRun,
  EDIT_OK_MARKER,
  CANONICAL_MARKER,
} from "../src/structured";

const exec = promisify(execFile);

describe("EditPlanSchema", () => {
  const valid = {
    edits: [
      {
        path: "src/payments.ts",
        function: "createPayment",
        oldText: "seenIdempotencyKeys.add(idempotencyKey);",
        newText: "if (x) throw new Error();\nseenIdempotencyKeys.add(idempotencyKey);",
      },
    ],
  };

  it("accepts a valid plan", () => {
    expect(EditPlanSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    [{}, "missing edits"],
    [{ edits: [] }, "empty edits"],
    [{ edits: [{ path: "a.ts", oldText: "x", newText: "x" }] }, "identical texts"],
    [{ edits: [{ path: "a.ts", oldText: "", newText: "y" }] }, "empty oldText"],
    [{ edits: [{ path: "a.ts", oldText: "x", newText: "y", extra: 1 }] }, "extra keys"],
    [{ edits: [{ oldText: "x", newText: "y" }] }, "missing path"],
    [{ edits: new Array(6).fill({ path: "a.ts", oldText: "x", newText: "y" }) }, "too many edits"],
  ])("rejects %s", (body) => {
    expect(EditPlanSchema.safeParse(body).success).toBe(false);
  });
});

describe("isSupportedEditPath", () => {
  it.each(["src/a.ts", "tests/b.test.tsx", "lib/c.jsx", "d.js"])(
    "accepts %s",
    (p) => {
      expect(isSupportedEditPath(p)).toBe(true);
    }
  );

  it.each([
    "",
    "/abs.ts",
    "../escape.ts",
    "a/../../b.ts",
    "./rel.ts",
    "back\\slash.ts",
    "binary.exe",
    "noext",
    "semi;colon.ts",
    ".hidden.ts",
    "a".repeat(201),
  ])("rejects %s", (p) => {
    expect(isSupportedEditPath(p)).toBe(false);
  });
});

describe("buildStructuredScript", () => {
  it("installs git before any git command, then validates and verifies", () => {
    const cmd = buildStructuredScript("pnpm", [], "pnpm test");
    // node images lack git: the installer must precede every git invocation.
    expect(cmd).toContain("apt-get install -y -qq git");
    // No model hunks anywhere: git owns the diff.
    expect(cmd).not.toContain("@@");
    const order = [
      "tar -xf",
      "apt-get install -y -qq git",
      "git init",
      "git commit",
      "validator.js",
      "git diff >",
      CANONICAL_MARKER,
      "git diff --check",
      "git stash",
      "git apply --check",
      "git stash pop",
      "PATCH_OK",
      "pnpm install",
      "VERIFY_BEGIN",
      "pnpm test",
    ];
    const idx = order.map((s) => cmd.indexOf(s));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe("parseStructuredRun", () => {
  const sha = "a".repeat(64);

  it("parses a full success", () => {
    const out = parseStructuredRun(
      [`${EDIT_OK_MARKER} 1`, `${CANONICAL_MARKER} ${sha} 123`, "PATCH_OK", "VERIFY_BEGIN"].join("\n")
    );
    expect(out).toEqual({
      editOk: true,
      editCategory: "ok",
      patchOk: true,
      verifyBegin: true,
      canonicalSha: sha,
      canonicalBytes: 123,
    });
  });

  it.each([
    ["EDIT_CONTEXT_MISMATCH:src/a.ts", "mismatch"],
    ["AMBIGUOUS_EDIT:src/a.ts", "ambiguous"],
    ["PATH_REJECTED:../x", "path"],
    ["SCHEMA_INVALID", "schema"],
    ["some other failure", "unknown"],
  ])("classifies %s as %s", (line, category) => {
    const out = parseStructuredRun(line);
    expect(out.editOk).toBe(false);
    expect(out.editCategory).toBe(category);
    expect(out.patchOk).toBe(false);
  });

  it("keeps patch history independent of suite outcome", () => {
    // PATCH_OK printed pre-install: a later suite failure must not
    // rewrite patchOk. Suite mapping lives in resolveForgeStatus.
    const out = parseStructuredRun(
      [`${EDIT_OK_MARKER} 1`, `${CANONICAL_MARKER} ${sha} 45`, "PATCH_OK", "VERIFY_BEGIN"].join("\n")
    );
    expect(out.patchOk).toBe(true);
    expect(out.canonicalBytes).toBe(45);
  });
});

describe("buildSourceExcerpts", () => {
  it("surfaces the focus-matched function with exact blob lines", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-excerpt-"));
    try {
      const content = Array.from({ length: 70 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src/payments.ts"), content);
      const opts = { cwd: dir, timeout: 30000 };
      await exec("git", ["init", "-q"], opts);
      await exec("git", ["config", "user.email", "t@t"], opts);
      await exec("git", ["config", "user.name", "t"], opts);
      await exec("git", ["add", "-A"], opts);
      await exec("git", ["commit", "-qm", "base"], opts);
      const { blocks } = await buildSourceExcerpts(
        dir,
        [
          { name: "unrelated", path: "src/other.ts", line: 1 },
          { name: "createPayment", path: "src/payments.ts", line: 41 },
        ],
        "idempotency"
      );
      // Focus match ranks first even though it was listed second.
      expect(blocks[0].path).toBe("src/payments.ts");
      expect(blocks[0].function).toBe("createPayment");
      expect(blocks[0].lines).toBe("38-71");
      expect(blocks[0].text).toContain("line38");
      expect(blocks[0].text).toContain("line70");
      expect(blocks[0].text).not.toContain("line37");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
