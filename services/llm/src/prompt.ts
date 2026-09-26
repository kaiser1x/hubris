export interface TwinSummary {  repoName: string;
  stats: {
    functions: number;
    classes: number;
    endpoints: number;
    tests: number;
    relationships: number;
  };
  functionNames: string[];
  endpoints: string[];
  // Preformatted "name — file:line" lines. Grounds the model in real paths
  // so it does not invent conventional layouts.
  functionDetails?: string[];
  // Preformatted "METHOD path → handler" lines from route registrations.
  routes?: string[];
}

export function buildInvestigatePrompt(summary: TwinSummary, question?: string): string {
  const functions =
    summary.functionDetails && summary.functionDetails.length > 0
      ? summary.functionDetails.slice(0, 25).join("\n")
      : summary.functionNames.slice(0, 15).join(", ") || "(none)";
  const lines = [
    `Repository: ${summary.repoName}`,
    `Functions: ${summary.stats.functions}, Classes: ${summary.stats.classes}, Endpoints: ${summary.stats.endpoints}, Tests: ${summary.stats.tests}, Relationships: ${summary.stats.relationships}`,
    `Routes:\n${summary.routes && summary.routes.length > 0 ? summary.routes.slice(0, 15).join("\n") : "(none listed)"}`,
    `Functions:\n${functions}`,
    `Endpoints: ${summary.endpoints.slice(0, 15).join(", ") || "(none)"}`,
    "",
    "Only cite files, functions, and routes listed above. Do not invent paths.",
    "",
    question?.trim() ||
      "What is the most likely location and cause of a bug in this codebase? Answer in under 150 words with file-level pointers.",
  ];
  return lines.join("\n");
}

export const INVESTIGATE_SYSTEM =
  "You are HUBRIS, a rigorous software-failure investigator. Reason from the provided codebase summary only. Be specific, cite function and file names, and keep answers short.";

export interface ForgeFunction {
  name: string;
  file: string;
  line: number;
}

export interface ForgeContext {
  repoName: string;
  stats: TwinSummary["stats"];
  functions: ForgeFunction[];
  endpoints: string[];
  relationships: string[];
  focus?: string;
  instruction?: string;
}

export function buildForgePrompt(ctx: ForgeContext): string {
  const fnLines = ctx.functions
    .slice(0, 40)
    .map((f) => `- ${f.name} (${f.file}:${f.line})`);
  const lines = [
    `Repository: ${ctx.repoName}`,
    `Functions: ${ctx.stats.functions}, Classes: ${ctx.stats.classes}, Endpoints: ${ctx.stats.endpoints}, Tests: ${ctx.stats.tests}, Relationships: ${ctx.stats.relationships}`,
    `Functions:\n${fnLines.join("\n") || "(none)"}`,
    `Endpoints: ${ctx.endpoints.slice(0, 15).join(", ") || "(none)"}`,
    `Key relationships:\n${ctx.relationships.slice(0, 40).join("\n") || "(none)"}`,
    ctx.focus?.trim() ? `Focus area: ${ctx.focus.trim()}` : "",
    "",
    ctx.instruction?.trim() ||
      "Propose the single most valuable minimal fix for this codebase.",
    "",
    "Respond with exactly three sections:",
    "1) PATCH — exactly one complete unified Git diff, and nothing else inside its code fence.",
    "The PATCH fence must contain ONLY the diff: no prose, no explanation, and never the target file mentioned only in a sentence.",
    "Every hunk must carry full Git headers, exactly like this:",
    "diff --git a/src/file.ts b/src/file.ts",
    "--- a/src/file.ts",
    "+++ b/src/file.ts",
    "@@ -<old line>,<count> +<new line>,<count> @@",
    "- old line",
    "+ new line",
    "The diff must pass `git apply --check patch.diff` verbatim.",
    "Hunk validity rules — a wrong count makes the whole patch unusable:",
    "- Every @@ header's old count must equal its removed + context lines; the new count must equal its added + context lines.",
    "- Copy context lines exactly from the real file; never invent line numbers.",
    "- Include enough unchanged context to anchor each hunk.",
    "Before returning PATCH, mentally verify that the hunk line counts and context are internally consistent. Do not return a partial or approximate diff.",
    "2) TEST — a regression test that fails before and passes after.",
    "3) WHY — two sentences maximum.",
    "Do not apply anything; this is a proposal only.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export const FORGE_SYSTEM =
  "You are HUBRIS, a careful patch author. Propose minimal, surgical changes grounded in the provided codebase summary. Never claim a fix is verified.";

export interface RegressionContext {
  repoName: string;
  stats: TwinSummary["stats"];
  functions: ForgeFunction[];
  // What behavior the test must pin down (e.g. "duplicate idempotency keys
  // are rejected"). Required: a test without a target is not a regression.
  focus: string;
  instruction?: string;
}

// Strip markdown code fences models love to wrap output in. Returns the
// inner content trimmed; untouched when no fences are present. Never throws.
export function stripCodeFences(text: string): string {
  const m = text.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n?```\s*$/);
  return (m ? m[1] : text).trim();
}

export function buildRegressionPrompt(ctx: RegressionContext): string {
  const fnLines = ctx.functions
    .slice(0, 40)
    .map((f) => `- ${f.name} (${f.file}:${f.line})`);
  const lines = [
    `Repository: ${ctx.repoName}`,
    `Functions: ${ctx.stats.functions}, Classes: ${ctx.stats.classes}, Endpoints: ${ctx.stats.endpoints}, Tests: ${ctx.stats.tests}, Relationships: ${ctx.stats.relationships}`,
    `Functions:\n${fnLines.join("\n") || "(none)"}`,
    `Target behavior: ${ctx.focus.trim()}`,
    ctx.instruction?.trim() ? `Additional instruction: ${ctx.instruction.trim()}` : "",
    "",
    "Write ONE Vitest test file that pins down the target behavior. Import from the relative paths shown above. Use only functions and files listed above — do not invent paths. Output ONLY the test file content: no markdown fences, no explanation.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export const REGRESSION_SYSTEM =
  "You are HUBRIS, a precise regression-test author. Write a single focused Vitest test grounded in the provided codebase summary. Output only code.";

// Bounded redraft instruction (Phase I). Sent at most ONCE per Forge run,
// only after git apply --check rejected the initial patch. Carries the
// original task plus the bounded git error — never secrets, never repo
// dumps. The model must return a complete unified diff, same contract.
export const REDRAFT_ERROR_CHARS = 1500;

export interface RedraftContext {
  originalDiff: string;
  gitError: string;
  focus?: string;
  instruction?: string;
}

export function buildRedraftPrompt(ctx: RedraftContext): string {
  const lines = [
    ctx.focus?.trim() ? `Original task: ${ctx.focus.trim()}` : "",
    ctx.instruction?.trim() ? `Additional instruction: ${ctx.instruction.trim()}` : "",
    "",
    "Your previous patch was rejected by `git apply --check`. Git error:",
    ctx.gitError.slice(0, REDRAFT_ERROR_CHARS),
    "",
    "Regenerate ONLY the PATCH section as a complete unified diff that applies cleanly to the provided repository.",
    "Do not change the intended fix.",
    "Use the exact file paths and context from the repository.",
    "Ensure all @@ line counts match the actual hunk contents.",
    "Return a complete Git-applicable unified diff.",
    "",
    "Previous patch for reference:",
    ctx.originalDiff,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export const REDRAFT_SYSTEM =
  "You are HUBRIS, a careful patch author. Correct the rejected patch so it applies cleanly with git apply. Output only the complete unified diff.";

export interface StructuredExcerpt {
  path: string;
  function: string;
  lines: string;
  text: string;
}

export interface StructuredContext {
  repoName: string;
  excerpts: StructuredExcerpt[];
  focus: string;
  instruction?: string;
}

// Structured edit plans replace direct diff generation: the model names
// the file, function, and exact texts, while HUBRIS owns hunk arithmetic
// (mechanical edit + git-generated canonical diff). JSON only — no prose,
// no fences — so parsing never guesses.
export function buildStructuredPrompt(ctx: StructuredContext): string {
  const blocks = ctx.excerpts.map(
    (e) => `--- ${e.path} (${e.function}, lines ${e.lines}) ---\n${e.text}`
  );
  const lines = [
    `Repository: ${ctx.repoName}`,
    `Target behavior: ${ctx.focus.trim()}`,
    ctx.instruction?.trim() ? `Additional instruction: ${ctx.instruction.trim()}` : "",
    "",
    "Relevant source:",
    blocks.join("\n\n") || "(none)",
    "",
    "Respond with ONLY a JSON object of exactly this shape, no markdown, no prose, no fences:",
    `{"edits": [{"path": "src/file.ts", "function": "name", "oldText": "exact existing source", "newText": "replacement source"}]}`,
    "Use double quotes, no comments, no trailing commas. Start your response with { and end with }.",
    "Make the smallest possible change required to fix the reported bug.",
    "Preserve all existing externally observable behavior unless the task explicitly requires changing it.",
    "Do not change existing error messages, return values, API shapes, function signatures, logging behavior, or unrelated logic unless required by the bug.",
    "Reuse existing constants, strings, and behavior whenever possible.",
    "Do not invent replacement wording when an existing error message already expresses the required behavior.",
    "Rules: paths are repo-relative; oldText must match the source above EXACTLY (character for character); copy it verbatim rather than retyping; keep newText minimal and consistent with surrounding style.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export const STRUCTURED_SYSTEM =
  "You are HUBRIS, a precise edit planner. Output only a JSON edit plan grounding every edit in the provided source excerpts.";

// Output budget for Forge-family calls (patch/test drafting). Reasoning
// models spend tokens thinking before answering: 1200 starved them
// mid-reasoning (finish_reason:length, content:null). 4096 gives the final
// content room to exist. Env-overridable; investigate (short answers)
// intentionally keeps the client default.
export const DEFAULT_FORGE_MAX_TOKENS = 4096;

export function forgeMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.HUBRIS_FORGE_MAX_TOKENS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_FORGE_MAX_TOKENS;
}

// Extract the PATCH section from a Forge suggestion (format: PATCH diff,
// then TEST, then WHY). Handles fenced and plain output. Returns the diff
// text or null when no usable patch exists. Never throws. Trailing prose
// (TEST/WHY sections) is cut: it would corrupt git apply.
export function extractForgePatch(suggestion: string): string | null {
  const plain = stripCodeFences(suggestion);
  const start = plain.indexOf("diff --git");
  if (start < 0) return null;
  const lines = plain.slice(start).split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // Stray fence lines around an inline-fenced diff carry no patch content.
    if (line.startsWith("```")) continue;
    const head = line[0];
    if (
      head !== " " && head !== "+" && head !== "-" && head !== "@" &&
      /^(#{1,6}\s+|\d+\)\s*|TEST\b|WHY\b)/i.test(line)
    ) {
      break;
    }
    kept.push(line);
  }
  const diff = kept.join("\n").trim();
  if (!diff.includes("@@")) return null;
  return diff;
}
