export interface TwinSummary {
  repoName: string;
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
    "Respond with exactly three sections: 1) PATCH — a minimal unified diff, 2) TEST — a regression test that fails before and passes after, 3) WHY — two sentences maximum. Do not apply anything; this is a proposal only.",
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
