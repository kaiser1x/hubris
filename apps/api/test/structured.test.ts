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
  parseSourceMarkers,
  parseStructuredRun,
  resolveJobRef,
  sourceMarkersMatch,
  EDIT_OK_MARKER,
  CANONICAL_MARKER,
  SOURCE_REF_MARKER,
  SOURCE_SHA_MARKER,
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

describe("resolveJobRef", () => {
  it("returns the persisted analyzed ref", () => {
    expect(resolveJobRef({ ref: "hubris/buggy-idempotency" })).toBe(
      "hubris/buggy-idempotency"
    );
  });

  it.each([[null], [undefined], [{}], [{ ref: null }], [{ ref: "" }], [{ ref: 42 }]])(
    "returns null for legacy/missing ref: %s",
    (result) => {
      expect(resolveJobRef(result)).toBeNull();
    }
  );

  it.each([["a;b"], ["--upload-pack=x"], ["../escape"], ["a".repeat(101)]])(
    "rejects unsafe ref %s",
    (ref) => {
      expect(resolveJobRef({ ref })).toBeNull();
    }
  );
});

describe("source revision markers", () => {
  const REF = "hubris/buggy-idempotency";
  const SHA = "2".repeat(40);

  it("script echoes the expected revision as markers", () => {
    const cmd = buildStructuredScript("pnpm", [], "pnpm test", { ref: REF, sha: SHA });
    expect(cmd).toContain(`${SOURCE_REF_MARKER} '${REF}'`);
    expect(cmd).toContain(`${SOURCE_SHA_MARKER} '${SHA}'`);
  });

  it("matching markers prove the sandbox ran the intended command", () => {
    const out = [`${SOURCE_REF_MARKER} ${REF}`, `${SOURCE_SHA_MARKER} ${SHA}`].join("\n");
    expect(parseSourceMarkers(out)).toEqual({ ref: REF, sha: SHA });
    expect(sourceMarkersMatch(out, REF, SHA)).toBe(true);
  });

  it("wrong ref or sha never matches", () => {
    const out = [`${SOURCE_REF_MARKER} main`, `${SOURCE_SHA_MARKER} ${SHA}`].join("\n");
    expect(sourceMarkersMatch(out, REF, SHA)).toBe(false);
    const out2 = [`${SOURCE_REF_MARKER} ${REF}`, `${SOURCE_SHA_MARKER} ${"3".repeat(40)}`].join("\n");
    expect(sourceMarkersMatch(out2, REF, SHA)).toBe(false);
  });

  it("missing markers fail closed, even for legacy empty expectations", () => {
    expect(sourceMarkersMatch("EDIT_OK 1", null, null)).toBe(false);
    expect(sourceMarkersMatch("", REF, SHA)).toBe(false);
  });

  it("legacy empty expectations match empty echoes", () => {
    const out = [`${SOURCE_REF_MARKER} `, `${SOURCE_SHA_MARKER} `].join("\n");
    expect(sourceMarkersMatch(out, null, null)).toBe(true);
  });
});
