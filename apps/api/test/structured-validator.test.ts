import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { VALIDATOR_JS } from "../src/structured";

const exec = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function mkTmp(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface ValidatorRun {
  code: number;
  stdout: string;
}

// Executes the REAL sandbox validator (plain node, no mocks) against a
// fixture workspace. Proves the exact-match/ambiguity/traversal/CRLF
// contract the sandbox will enforce.
async function runValidator(
  workspace: string,
  edits: unknown
): Promise<ValidatorRun> {
  const dir = await mkTmp("hubris-validator-");
  try {
    fs.writeFileSync(path.join(dir, "validator.js"), VALIDATOR_JS);
    fs.writeFileSync(path.join(dir, "edits.json"), JSON.stringify(edits));
    try {
      const out = await exec("node", ["validator.js", workspace, "edits.json"], {
        cwd: dir,
        timeout: 30000,
      });
      return { code: 0, stdout: out.stdout };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string };
      return { code: err.code ?? 99, stdout: String(err.stdout ?? "") };
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function writeWorkspace(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe("validator execution", () => {
  // The exact buggy-fixture shape: guard-less block gains the has() check.
  // Proves the intended live edit is mechanically applicable (test 2/4).
  it("applies the idempotency-guard restoration", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, {
        "src/payments.ts":
          "  if (idempotencyKey !== undefined) {\n    seenIdempotencyKeys.add(idempotencyKey);\n  }\n",
      });
      const r = await runValidator(ws, {
        edits: [
          {
            path: "src/payments.ts",
            function: "createPayment",
            oldText:
              "  if (idempotencyKey !== undefined) {\n    seenIdempotencyKeys.add(idempotencyKey);\n  }",
            newText:
              "  if (idempotencyKey !== undefined) {\n    if (seenIdempotencyKeys.has(idempotencyKey)) {\n      throw new Error(`duplicate payment for key ${idempotencyKey}`);\n    }\n    seenIdempotencyKeys.add(idempotencyKey);\n  }",
          },
        ],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("EDIT_OK 1");
      expect(fs.readFileSync(path.join(ws, "src/payments.ts"), "utf-8")).toContain(
        "seenIdempotencyKeys.has(idempotencyKey)"
      );
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("contract: the guard restoration preserves the original error message", async () => {
    // The observable contract the suite pins: repeated keys are rejected
    // with the ORIGINAL message. A prior live draft invented
    // "Duplicate idempotency key" instead and failed verification — a
    // contract change, not a mechanical failure. This test pins the message
    // so the fixture can never be "fixed" to the invented wording.
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, {
        "src/payments.ts":
          "  if (idempotencyKey !== undefined) {\n    seenIdempotencyKeys.add(idempotencyKey);\n  }\n",
      });
      const restoration =
        "  if (idempotencyKey !== undefined) {\n    if (seenIdempotencyKeys.has(idempotencyKey)) {\n      throw new Error(`duplicate payment for key ${idempotencyKey}`);\n    }\n    seenIdempotencyKeys.add(idempotencyKey);\n  }";
      expect(restoration).toContain("duplicate payment for key");
      expect(restoration).not.toContain("Duplicate idempotency key");
      const r = await runValidator(ws, {
        edits: [
          {
            path: "src/payments.ts",
            function: "createPayment",
            oldText:
              "  if (idempotencyKey !== undefined) {\n    seenIdempotencyKeys.add(idempotencyKey);\n  }",
            newText: restoration,
          },
        ],
      });
      expect(r.code).toBe(0);
      const after = fs.readFileSync(path.join(ws, "src/payments.ts"), "utf-8");
      expect(after).toContain("duplicate payment for key");
      expect(after).not.toContain("Duplicate idempotency key");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("1-2. applies on exactly one match", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, { "src/a.ts": "const x = 1;\n" });
      const r = await runValidator(ws, {
        edits: [{ path: "src/a.ts", oldText: "const x = 1;", newText: "const x = 2;" }],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("EDIT_OK 1");
      expect(fs.readFileSync(path.join(ws, "src/a.ts"), "utf-8")).toBe("const x = 2;\n");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("3. rejects zero matches", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, { "src/a.ts": "const x = 1;\n" });
      const r = await runValidator(ws, {
        edits: [{ path: "src/a.ts", oldText: "nope", newText: "y" }],
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("EDIT_CONTEXT_MISMATCH");
      expect(fs.readFileSync(path.join(ws, "src/a.ts"), "utf-8")).toBe("const x = 1;\n");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("4. rejects multiple matches without choosing", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, { "src/a.ts": "foo();\nfoo();\n" });
      const r = await runValidator(ws, {
        edits: [{ path: "src/a.ts", oldText: "foo();", newText: "bar();" }],
      });
      expect(r.code).toBe(3);
      expect(r.stdout).toContain("AMBIGUOUS_EDIT");
      expect(fs.readFileSync(path.join(ws, "src/a.ts"), "utf-8")).toBe("foo();\nfoo();\n");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("5. rejects path traversal", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, { "src/a.ts": "x" });
      const r = await runValidator(ws, {
        edits: [{ path: "../outside.ts", oldText: "x", newText: "y" }],
      });
      expect(r.code).toBe(4);
      expect(r.stdout).toContain("PATH_REJECTED");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("6. rejects malformed plans", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      writeWorkspace(ws, { "src/a.ts": "x" });
      for (const bad of [{}, { edits: [] }, { edits: [{ path: "a" }] }, "not-json"]) {
        const dir = await mkTmp("hubris-validator-");
        try {
          fs.writeFileSync(path.join(dir, "validator.js"), VALIDATOR_JS);
          fs.writeFileSync(
            path.join(dir, "edits.json"),
            typeof bad === "string" ? bad : JSON.stringify(bad)
          );
          await expect(
            exec("node", ["validator.js", ws, "edits.json"], { cwd: dir, timeout: 30000 })
          ).rejects.toMatchObject({ code: 5 });
        } finally {
          await fs.promises.rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("10. byte-exact ops never normalize surrounding bytes", async () => {
    const ws = await mkTmp("hubris-ws-");
    try {
      // Substring match is byte-exact: the trailing CR is preserved, not
      // rewritten — the validator never normalizes file content.
      fs.writeFileSync(path.join(ws, "a.ts"), "const x = 1;\r\n");
      const r = await runValidator(ws, {
        edits: [{ path: "a.ts", oldText: "const x = 1;", newText: "const x = 2;" }],
      });
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(ws, "a.ts"), "utf-8")).toBe("const x = 2;\r\n");
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });
});

describe("canonical diff round-trip (git owns the headers)", () => {
  it("7-9. mechanical edit → git diff → both checks pass", async () => {
    const ws = await mkTmp("hubris-canonical-");
    try {
      writeWorkspace(ws, { "src/a.ts": "export const x = 1;\n" });
      const opts = { cwd: ws, timeout: 30000 };
      await exec("git", ["init", "-q"], opts);
      await exec("git", ["config", "user.email", "t@t"], opts);
      await exec("git", ["config", "user.name", "t"], opts);
      await exec("git", ["add", "-A"], opts);
      await exec("git", ["commit", "-qm", "base"], opts);
      // Mechanical replacement (what the validator does), then git authors
      // the patch: headers, counts, and context all machine-generated.
      const file = path.join(ws, "src/a.ts");
      const before = fs.readFileSync(file, "utf-8");
      expect(before.split("const x = 1;").length - 1).toBe(1);
      fs.writeFileSync(file, before.replace("const x = 1;", "const x = 2;"));
      const diff = (await exec("git", ["diff", "--", "src/a.ts"], opts)).stdout;
      // The edit input carried no diff syntax at all, yet git produced a
      // complete applicable patch: diff headers and @@ hunks are
      // machine-authored, never model-supplied.
      expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
      expect(diff).toContain("@@");
      fs.writeFileSync(path.join(ws, "c.patch"), diff);
      await exec("git", ["diff", "--check"], opts);
      await exec("git", ["stash", "-q"], opts);
      await exec("git", ["apply", "--check", "c.patch"], opts);
      await exec("git", ["stash", "pop", "-q"], opts);
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });
});
