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
import { isSafeGitRef, REPO_WORKDIR } from "@hubris/sandbox";
import { CHECKOUT_UPLOAD_PATH } from "./checkout";
import { INSTALL_COMMANDS, type PackageManager } from "./install";
import { TARGET_VERIFY_DONE_MARKER, VERIFY_BEGIN_MARKER } from "./forgeverify";

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

// `{ "edits": [] }`: the model's explicit "nothing to change". Recognized
// before schema validation so it is reported as such rather than as a
// broken plan. It never passes the schema (min 1) and never reaches a sandbox.
export function isEmptyEditPlan(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { edits?: unknown }).edits) &&
    (raw as { edits: unknown[] }).edits.length === 0
  );
}
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
  // Anchor metadata (safe, bounded): which function the window anchors on,
  // whether it is the investigation's explicit target, and whether the
  // function body extends past the excerpt window.
  anchorLine: number;
  targetIncluded: boolean;
  truncated: boolean;
}

// Window shape for source excerpts. The window anchors on the target
// function's real location and is extended (up to a bound) so the function
// body is normally included in full. Lead lines give context before the
// signature; the body-extension bound caps how far a very large function can
// grow the window. Never unbounded.
export const EXCERPT_LEAD_LINES = 3;
export const EXCERPT_BODY_EXTEND_LINES = 60;

export type TwinFunctionLocation = {
  name?: string;
  path?: string;
  line?: number;
  // 1-based end line of the function body. Absent on legacy twins analyzed
  // before end-line tracking — the caller then uses the plain 60-line window
  // and treats the body as unknown.
  endLine?: number;
};

// Resolve the revision a Forge run must check out: the job's persisted
// analyzed ref (result.ref, written by POST /api/analyze when it cloned
// with --branch). Returns null for legacy jobs analyzed before ref
// persistence or with an unsafe value — callers then keep the previous
// default-branch behavior explicitly, never a fabricated ref.
export function resolveJobRef(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const ref = (result as { ref?: unknown }).ref;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 100) return null;
  return isSafeGitRef(ref) ? ref : null;
}

export function resolveJobCommitSha(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const commitSha = (result as { commitSha?: unknown }).commitSha;
  return typeof commitSha === "string" && /^[a-f0-9]{40}$/.test(commitSha)
    ? commitSha
    : null;
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
//
// Target-aware anchoring: when the focus names a Target (the repair
// contract), the excerpt window for that file is anchored on the target
// function's real source line and extended (bounded) to include the whole
// function body. Non-target files keep the previous behavior anchored on
// their best-matching function. Deterministic ordering is preserved.
export async function buildSourceExcerpts(
  src: string,
  functions: TwinFunctionLocation[],
  focus: string
): Promise<{ blocks: SourceExcerpt[]; totalChars: number; truncated: boolean }> {
  const needle = focus.toLowerCase();
  const targetMatch = focus.match(/Target:\s*([^\s(]+)\s*\(([^)]+)\)/i);
  const targetFunction = targetMatch?.[1]?.toLowerCase() ?? "";
  const targetPath = targetMatch?.[2]?.toLowerCase() ?? "";
  const focusTerms = focus
    .split(/[^a-z0-9_./-]+/i)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3);
  const ranked = [...functions].sort((a, b) => {
    const score = (f: { name?: string; path?: string }) => {
      const name = (f.name ?? "").toLowerCase();
      const path = (f.path ?? "").toLowerCase();
      if ((targetFunction && name === targetFunction) || (targetPath && path === targetPath)) return 0;
      if (`${name} ${path}`.includes(needle)) return 1;
      return 2 - Math.min(1, focusTerms.filter((term) => name.includes(term) || path.includes(term)).length);
    };
    return score(a) - score(b);
  });

  // The explicit target function in the target file, if present.
  const targetFn =
    targetFunction && targetPath
      ? functions.find(
          (f) =>
            (f.path ?? "").toLowerCase() === targetPath &&
            (f.name ?? "").toLowerCase() === targetFunction
        )
      : undefined;

  const blocks: SourceExcerpt[] = [];
  let totalChars = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const fn of ranked) {
    if (blocks.length >= EXCERPT_MAX_FUNCS) break;
    const filePath = fn.path;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    // Anchor on the explicit target when this is the target file; otherwise
    // on the best-ranked function in this file (first in ranked order).
    const anchor =
      targetFn && (targetFn.path ?? "").toLowerCase() === filePath.toLowerCase()
        ? targetFn
        : fn;
    const anchorLine = anchor.line && anchor.line > 0 ? anchor.line : 1;
    const fnEndLine =
      typeof anchor.endLine === "number" && anchor.endLine >= anchorLine
        ? anchor.endLine
        : undefined;

    const lines = await blobLines(src, filePath);
    if (!lines) continue;

    const startLine = Math.max(1, anchorLine - EXCERPT_LEAD_LINES);
    const defaultEnd = startLine + EXCERPT_MAX_LINES - 1;
    const extendedCap = startLine + EXCERPT_MAX_LINES + EXCERPT_BODY_EXTEND_LINES - 1;
    // Include the whole body when it fits within the extended cap; otherwise
    // keep the bounded window and report truncation rather than pretending
    // the entire function was provided.
    const desiredEnd = fnEndLine !== undefined ? Math.max(defaultEnd, fnEndLine) : defaultEnd;
    const endLine = Math.min(desiredEnd, extendedCap, lines.length);
    const bodyTruncated = fnEndLine !== undefined && fnEndLine > endLine;

    const slice = lines.slice(startLine - 1, endLine);
    const text = slice.join("\n");
    const block: SourceExcerpt = {
      path: filePath,
      function: anchor.name ?? "(anonymous)",
      lines: `${startLine}-${endLine}`,
      text: text.slice(0, 4000),
      anchorLine,
      targetIncluded:
        targetFn !== undefined &&
        (anchor.name ?? "").toLowerCase() === targetFunction &&
        (anchor.path ?? "").toLowerCase() === targetPath,
      truncated: bodyTruncated,
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
export const CANONICAL_B64_MARKER = "CANONICAL_B64";
export const SOURCE_REF_MARKER = "SOURCE_REF";
export const SOURCE_SHA_MARKER = "SOURCE_SHA";

// Full structured run: extract, baseline-commit, mechanical apply,
// canonical diff + both git checks, install, targeted verification of the
// investigated scenario (when provided), then the full suite.
// Canonical diff is machine-generated (git diff), never model-written.
// The expected source revision (resolved server-side from the job) is
// echoed back as markers so the outcome can prove the sandbox executed
// the intended command uncorrupted. File provenance itself rests on the
// tarball sha256 + file-count checks; these markers are command-integrity
// evidence, not a substitute for them.
export function buildStructuredScript(
  manager: PackageManager,
  excluded: string[],
  verifyInvoke: string,
  expected: { ref: string | null; sha: string | null } = { ref: null, sha: null },
  // Targeted command for the exact investigated scenario. Null when the
  // investigation supplied no scenario or the runner is unsupported — the
  // verification phase then runs the full suite only.
  targetCommand: string | null = null
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
    // Echo the EXACT canonical patch bytes (base64) so HUBRIS can persist the
    // same patch the sandbox validated and applied — never reconstructed later.
    `echo ${CANONICAL_B64_MARKER} $(base64 -w0 /tmp/canonical.patch); ` +
    `echo ${SOURCE_REF_MARKER} ${shQuote(expected.ref ?? "")}; echo ${SOURCE_SHA_MARKER} ${shQuote(expected.sha ?? "")}; ` +
    `git diff --check; ` +
    `git stash -q; git apply --check /tmp/canonical.patch; git stash pop -q; ` +
    `echo PATCH_OK; ` +
    `${INSTALL_COMMANDS[manager]}; echo VERIFY_BEGIN; ` +
    // Verification runs WITHOUT `set -e` so a failing target or a failing full
    // suite is captured as evidence instead of aborting the script.
    `set +e; ` +
    (targetCommand
      ? `${targetCommand}; TARGET_EXIT=$?; echo ${TARGET_VERIFY_DONE_MARKER} $TARGET_EXIT; `
      : "") +
    `${invoke}; FULL_EXIT=$?; exit $FULL_EXIT`
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

export interface StructuredSourceMarkers {
  ref: string | null;
  sha: string | null;
}

// Parse the echoed source-revision markers. A present-but-empty marker
// yields "" (legacy jobs genuinely have no ref); an ABSENT marker yields
// null (never fabricated). The match check below is fail-closed on nulls.
export function parseSourceMarkers(stdout: string): StructuredSourceMarkers {
  const refMatch = stdout.match(new RegExp(`^${SOURCE_REF_MARKER} (.*)$`, "m"));
  const shaMatch = stdout.match(new RegExp(`^${SOURCE_SHA_MARKER} (.*)$`, "m"));
  return {
    ref: refMatch ? refMatch[1].trim() : null,
    sha: shaMatch ? shaMatch[1].trim() : null,
  };
}

// The sandbox executed the intended revision command when the echoed
// markers equal the server-resolved expectation. Fail-closed: absent
// markers never match, even when both sides are empty.
export function sourceMarkersMatch(
  stdout: string,
  expectedRef: string | null,
  expectedSha: string | null
): boolean {
  if (!stdout.includes(`${SOURCE_REF_MARKER} `) || !stdout.includes(`${SOURCE_SHA_MARKER} `)) {
    return false;
  }
  const got = parseSourceMarkers(stdout);
  if (got.ref === null || got.sha === null) return false;
  return got.ref === (expectedRef ?? "") && got.sha === (expectedSha ?? "");
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

// Decode the base64 canonical patch echoed by the sandbox. Returns the exact
// bytes as UTF-8 text, or null when the marker is absent/malformed. This is the
// ONLY source of the SHIP patch: never reconstructed from the model, the edit
// plan, or the contract.
export function parseCanonicalPatchContent(stdout: string): string | null {
  if (typeof stdout !== "string") return null;
  // Tolerate trailing whitespace / CR so a CRLF-normalized stream still parses.
  const m = stdout.match(new RegExp(`^${CANONICAL_B64_MARKER} ([A-Za-z0-9+/=]*)[\\r\\t ]*$`, "m"));
  if (!m) return null;
  if (m[1].length === 0) return "";
  try {
    return Buffer.from(m[1], "base64").toString("utf-8");
  } catch {
    return null;
  }
}
