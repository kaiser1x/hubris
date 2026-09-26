// Phase I (structured) — machine-built patches from model-named edits.
//
// The model names file/function/exact texts (JSON); HUBRIS owns everything
// structural: exact-match validation, mechanical application, canonical
// diff generation via git itself, and both git checks. The model never
// touches hunk counts, line numbers, or diff headers — eliminating the
// failure class that blocked direct diff generation.
//
// Byte discipline: excerpts are read from `git show HEAD:path` (raw blob
// bytes, LF-pinned like the transfer tarball), never from host working
// copies that a converting checkout may have rewritten.

import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";
import { VERIFY_BEGIN_MARKER } from "./forgeverify";

const execFileAsync = promisify(execFile);

export const STRUCTURED_UPLOAD_VALIDATOR = "/tmp/hubris-upload/validator.js";
export const STRUCTURED_UPLOAD_EDITS = "/tmp/hubris-upload/edits.json";

// Excerpt budget: bounded source context per prompt (Part 2).
export const EXCERPT_MAX_FUNCS = 8;
export const EXCERPT_MAX_LINES = 60;
export const EXCERPT_MAX_CHARS = 15000;

// Strict machine contract: exactly the edit list, nothing else.
const StructuredEditSchema = z
  .object({
    path: z.string().min(1).max(200),
    function: z.string().max(200).optional(),
    oldText: z.string().min(1).max(4000),
    newText: z.string().max(4000),
  })
  .strict()
  .refine((e) => e.oldText !== e.newText, "oldText and newText must differ");

export const EditPlanSchema = z
  .object({
    edits: z.array(StructuredEditSchema).min(1).max(5),
  })
  .strict();

export type EditPlan = z.infer<typeof EditPlanSchema>;
export type StructuredEdit = EditPlan["edits"][number];

const EDIT_PATH_EXTS = [".ts", ".tsx", ".js", ".jsx"];

// Workspace-relative destination gate: relative posix, no traversal,
// source-code extensions only. Tracked-membership is checked separately
// against the clone (target must exist in the repo).
export function isSupportedEditPath(p: string): boolean {
  if (p.length < 1 || p.length > 200) return false;
  if (p.includes("\\")) return false;
  if (p.startsWith("/") || p.startsWith(".")) return false;
  const segs = p.split("/");
  if (segs.some((s) => s.length === 0 || s === "..")) return false;
  if (segs.some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) return false;
  const dot = p.lastIndexOf(".");
  if (dot < 0 || !EDIT_PATH_EXTS.includes(p.slice(dot).toLowerCase())) return false;
  return true;
}

export interface SourceExcerpt {
  path: string;
  function: string;
  lines: string;
  text: string;
}

async function blobLines(src: string, filePath: string): Promise<string[] | null> {
  try {
    const out = await execFileAsync(
      "git",
      ["-C", src, "-c", "core.autocrlf=false", "show", `HEAD:${filePath}`],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
    );
    return out.stdout.split("\n");
  } catch {
    return null;
  }
}

// Bounded excerpts for focus-relevant twin functions, read from blob bytes
// (identical to what the tarball carries). Focus substring match on
// name/path first, twin order as fallback so the prompt is never empty.
export async function buildSourceExcerpts(
  src: string,
  functions: Array<{ name?: string; path?: string; line?: number }>,
  focus: string
): Promise<{ blocks: SourceExcerpt[]; totalChars: number; truncated: boolean }> {
  const needle = focus.toLowerCase();
  const ranked = [...functions].sort((a, b) => {
    const score = (f: { name?: string; path?: string }) =>
      `${f.name ?? ""} ${f.path ?? ""}`.toLowerCase().includes(needle) ? 0 : 1;
    return score(a) - score(b);
  });
  const blocks: SourceExcerpt[] = [];
  let totalChars = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const fn of ranked) {
    if (blocks.length >= EXCERPT_MAX_FUNCS) break;
    const filePath = fn.path;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const lines = await blobLines(src, filePath);
    if (!lines) continue;
    const start = Math.max(1, (fn.line ?? 1) - 3);
    const slice = lines.slice(start - 1, start - 1 + EXCERPT_MAX_LINES);
    const end = start + slice.length - 1;
    const text = slice.join("\n");
    const block: SourceExcerpt = {
      path: filePath,
      function: fn.name ?? "(anonymous)",
      lines: `${start}-${end}`,
      text: text.slice(0, 4000),
    };
    const size = block.path.length + block.function.length + block.text.length;
    if (totalChars + size > EXCERPT_MAX_CHARS) {
      truncated = true;
      break;
    }
    totalChars += size;
    blocks.push(block);
  }
  return { blocks, totalChars, truncated };
}

// Sandbox-side validator + applier (runs under node in the sandbox).
// Protocol: argv [workspace, editsJson]. Exit 0 + EDIT_OK on success;
// 2 EDIT_CONTEXT_MISMATCH, 3 AMBIGUOUS_EDIT, 4 PATH_REJECTED, 5 schema.
// Byte-exact string ops: no normalization, no regex, no fuzz.
export const VALIDATOR_JS = `const fs = require("fs");
const path = require("path");
const [workspace, editsFile] = process.argv.slice(2);
function fail(code, label, detail) {
  console.log(label + (detail ? ":" + detail : ""));
  process.exit(code);
}
let plan;
try {
  plan = JSON.parse(fs.readFileSync(editsFile, "utf-8"));
} catch {
  fail(5, "SCHEMA_INVALID");
}
if (!plan || !Array.isArray(plan.edits) || plan.edits.length === 0) fail(5, "SCHEMA_INVALID");
let n = 0;
for (const e of plan.edits) {
  if (!e || typeof e.path !== "string" || typeof e.oldText !== "string" || typeof e.newText !== "string") fail(5, "SCHEMA_INVALID");
  if (e.oldText.length === 0) fail(2, "EDIT_CONTEXT_MISMATCH", e.path);
  const dest = path.normalize(path.join(workspace, e.path));
  if (dest !== workspace && !dest.startsWith(workspace + path.sep)) fail(4, "PATH_REJECTED", e.path);
  let content;
  try {
    content = fs.readFileSync(dest, "utf-8");
  } catch {
    fail(2, "EDIT_CONTEXT_MISMATCH", e.path);
  }
  const count = content.split(e.oldText).length - 1;
  if (count === 0) fail(2, "EDIT_CONTEXT_MISMATCH", e.path);
  if (count > 1) fail(3, "AMBIGUOUS_EDIT", e.path);
  fs.writeFileSync(dest, content.replace(e.oldText, e.newText));
  n++;
}
console.log("EDIT_OK " + n);
`;

function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const EDIT_OK_MARKER = "EDIT_OK";
export const CANONICAL_MARKER = "CANONICAL_SHA";

// Full structured run: extract, baseline-commit, mechanical apply,
// canonical diff + both git checks, install, verification command.
// Canonical diff is machine-generated (git diff), never model-written.
export function buildStructuredScript(
  manager: PackageManager,
  excluded: string[],
  verifyInvoke: string
): string {
  const dir = shQuote(REPO_WORKDIR);
  const tar = shQuote(CHECKOUT_UPLOAD_PATH);
  const validator = shQuote(STRUCTURED_UPLOAD_VALIDATOR);
  const edits = shQuote(STRUCTURED_UPLOAD_EDITS);
  const rm =
    excluded.length > 0 ? `rm -f ${excluded.map(shQuote).join(" ")}; ` : "";
  const invoke = verifyInvoke;
  return (
    `set -e; rm -rf ${dir}; mkdir -p ${dir}; ` +
    `tar -xf ${tar} -C ${dir}; cd ${dir}; ${rm}` +
    `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1; ` +
    `git init -q; git config user.email t@t; git config user.name t; git add -A; git commit -qm base; ` +
    `node ${validator} ${dir} ${edits}; ` +
    `git diff > /tmp/canonical.patch; echo ${CANONICAL_MARKER} $(sha256sum /tmp/canonical.patch | cut -d' ' -f1) $(wc -c < /tmp/canonical.patch); ` +
    `git diff --check; ` +
    `git stash -q; git apply --check /tmp/canonical.patch; git stash pop -q; ` +
    `echo PATCH_OK; ` +
    `${INSTALL_COMMANDS[manager]}; echo VERIFY_BEGIN; ${invoke}`
  );
}

export interface StructuredRunOutcome {
  editOk: boolean;
  editCategory: "ok" | "mismatch" | "ambiguous" | "path" | "schema" | "unknown";
  patchOk: boolean;
  verifyBegin: boolean;
  canonicalSha: string | null;
  canonicalBytes: number | null;
}

// Markers only: PATCH_OK prints after the canonical checks pass, before
// install — so patchOk is independent of the later suite exit code (a
// failing suite must not rewrite patch history). Suite outcome flows
// through resolveForgeStatus separately.
export function parseStructuredRun(stdout: string): StructuredRunOutcome {
  const editOk = stdout.includes(`${EDIT_OK_MARKER} `) || /EDIT_OK$/.test(stdout.trimEnd());
  const editCategory: StructuredRunOutcome["editCategory"] = editOk
    ? "ok"
    : stdout.includes("AMBIGUOUS_EDIT")
      ? "ambiguous"
      : stdout.includes("PATH_REJECTED")
        ? "path"
        : stdout.includes("SCHEMA_INVALID")
          ? "schema"
          : stdout.includes("EDIT_CONTEXT_MISMATCH")
            ? "mismatch"
            : "unknown";
  const shaMatch = stdout.match(/CANONICAL_SHA ([a-f0-9]{64}) (\d+)/);
  const canonicalSha = shaMatch ? shaMatch[1] : null;
  const canonicalBytes = shaMatch ? Number(shaMatch[2]) : null;
  const patchOk = editOk && canonicalSha !== null && stdout.includes("PATCH_OK");
  const verifyBegin = stdout.includes("VERIFY_BEGIN");
  return { editOk, editCategory, patchOk, verifyBegin, canonicalSha, canonicalBytes };
}
