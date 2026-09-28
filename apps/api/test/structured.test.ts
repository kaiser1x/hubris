import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  resolveJobCommitSha,
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

describe("revision metadata", () => {
  it("accepts only a full analyzed commit SHA", () => {
    const sha = "a".repeat(40);
    expect(resolveJobCommitSha({ commitSha: sha })).toBe(sha);
    expect(resolveJobCommitSha({ commitSha: "moving-branch" })).toBeNull();
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

describe("buildSourceExcerpts target-aware anchoring", () => {
  let dir: string;
  const FILE = "src/payments.ts";
  const FUNCS = [
    { name: "first", path: FILE, line: 1, endLine: 3 },
    { name: "second", path: FILE, line: 6, endLine: 8 },
    { name: "big", path: FILE, line: 10, endLine: 159 },
    { name: "refund", path: FILE, line: 161, endLine: 164 },
  ];

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hubris-excerpt-anchor-"));
    const lines: string[] = [];
    lines.push(
      "export function first() {", // 1
      "  return 1",                 // 2
      "}",                          // 3
      "",                           // 4
      "",                           // 5
      "export function second() {", // 6
      "  return 2",                 // 7
      "}",                          // 8
      ""                            // 9
    );
    lines.push("export function big() {"); // 10
    for (let i = 0; i < 148; i++) lines.push(`  const v${i} = ${i};`); // 11-158
    lines.push("}"); // 159
    lines.push(""); // 160
    lines.push("export function refund(id) {"); // 161
    lines.push("  const p = get(id);");          // 162
    lines.push("  return p;");                   // 163
    lines.push("}");                             // 164
    const content = lines.join("\n") + "\n";     // 165 elements after split
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), content);
    fs.writeFileSync(
      path.join(dir, "src/other.ts"),
      "export function helper() {\n  return 1;\n}\n"
    );
    const opts = { cwd: dir, timeout: 30000 };
    await exec("git", ["init", "-q"], opts);
    await exec("git", ["config", "user.email", "t@t"], opts);
    await exec("git", ["config", "user.name", "t"], opts);
    await exec("git", ["add", "-A"], opts);
    await exec("git", ["commit", "-qm", "base"], opts);
  });

  afterAll(async () => {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("anchors the excerpt on the target function's real line and includes its body", async () => {
    const { blocks } = await buildSourceExcerpts(dir, FUNCS, "Target: refund (src/payments.ts)");
    const block = blocks.find((b) => b.path === FILE);
    expect(block).toBeDefined();
    expect(block!.anchorLine).toBe(161);
    expect(block!.targetIncluded).toBe(true);
    expect(block!.truncated).toBe(false);
    // startLine = 161 - 3 = 158; window extends to the end of the file.
    expect(block!.lines).toBe("158-165");
    expect(block!.text).toContain("export function refund(id)");
    expect(block!.text).toContain("const p = get(id);");
  });

  it("caps a large target function deterministically and reports truncation", async () => {
    const { blocks } = await buildSourceExcerpts(dir, FUNCS, "Target: big (src/payments.ts)");
    const block = blocks.find((b) => b.path === FILE);
    expect(block).toBeDefined();
    expect(block!.anchorLine).toBe(10);
    expect(block!.targetIncluded).toBe(true);
    expect(block!.truncated).toBe(true);
    // startLine = 7, extendedCap = 7 + 60 + 60 - 1 = 126; body ends at 159.
    expect(block!.lines).toBe("7-126");
    expect(block!.text).toContain("export function big() {");
    expect(block!.text).not.toContain("const v148");
  });

  it("anchors on the focus-matched function's real line when no target is named", async () => {
    const { blocks } = await buildSourceExcerpts(dir, FUNCS, "second");
    const block = blocks.find((b) => b.path === FILE);
    expect(block).toBeDefined();
    expect(block!.anchorLine).toBe(6);
    expect(block!.targetIncluded).toBe(false);
    // startLine = 3, default window = 60 lines.
    expect(block!.lines).toBe("3-62");
    expect(block!.text).toContain("export function second() {");
    expect(block!.text).toContain("return 2");
  });

  it("legacy functions without an end line keep the bounded window, never truncation claims", async () => {
    const legacy = [
      { name: "refund", path: FILE, line: 161 },
    ];
    const { blocks } = await buildSourceExcerpts(dir, legacy, "Target: refund (src/payments.ts)");
    const block = blocks.find((b) => b.path === FILE);
    expect(block).toBeDefined();
    expect(block!.anchorLine).toBe(161);
    expect(block!.truncated).toBe(false);
    expect(block!.lines).toBe("158-165");
    expect(block!.text).toContain("export function refund(id)");
  });

  it("keeps deterministic ordering and file dedup across targets", async () => {
    const { blocks } = await buildSourceExcerpts(dir, FUNCS, "Target: second (src/payments.ts)");
    expect(new Set(blocks.map((b) => b.path)).size).toBe(blocks.length);
    expect(blocks[0].path).toBe(FILE);
  });

  it("marks only the explicit target file as targetIncluded", async () => {
    const funcs = [
      ...FUNCS,
      { name: "helper", path: "src/other.ts", line: 1, endLine: 3 },
    ];
    const { blocks } = await buildSourceExcerpts(dir, funcs, "Target: refund (src/payments.ts)");
    const target = blocks.find((b) => b.path === FILE);
    const other = blocks.find((b) => b.path === "src/other.ts");
    expect(target?.targetIncluded).toBe(true);
    expect(target?.anchorLine).toBe(161);
    expect(other?.targetIncluded).toBe(false);
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

describe("buildStructuredScript targeted scenario verification", () => {
  it("runs the exact target command after VERIFY_BEGIN and before the full suite", () => {
    const target =
      "pnpm exec vitest run 'tests/orders.test.ts' -t 'applies a discount code to the order total'";
    const cmd = buildStructuredScript("pnpm", [], "pnpm test", { ref: null, sha: null }, target);
    const iVerify = cmd.indexOf("VERIFY_BEGIN");
    const iTarget = cmd.indexOf(target);
    const iMarker = cmd.indexOf("TARGET_VERIFY_DONE");
    const iFull = cmd.indexOf("pnpm test", iMarker);
    expect(iVerify).toBeGreaterThanOrEqual(0);
    expect(iTarget).toBeGreaterThan(iVerify);
    expect(iMarker).toBeGreaterThan(iTarget);
    expect(iFull).toBeGreaterThan(iMarker);
    // The verification phase drops `set -e` so a failing target is evidence.
    const iSetPlusE = cmd.lastIndexOf("set +e");
    expect(iSetPlusE).toBeGreaterThanOrEqual(0);
    expect(iSetPlusE).toBeLessThan(iTarget);
    expect(cmd).toContain("TARGET_EXIT=$?");
    expect(cmd).toContain("exit $FULL_EXIT");
  });

  it("omits the targeted step when no target command is provided", () => {
    const cmd = buildStructuredScript("pnpm", [], "pnpm test");
    expect(cmd).not.toContain("TARGET_VERIFY_DONE");
    expect(cmd).toContain("VERIFY_BEGIN");
  });
});
