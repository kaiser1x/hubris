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
}

export function buildInvestigatePrompt(summary: TwinSummary, question?: string): string {
  const lines = [
    `Repository: ${summary.repoName}`,
    `Functions: ${summary.stats.functions}, Classes: ${summary.stats.classes}, Endpoints: ${summary.stats.endpoints}, Tests: ${summary.stats.tests}, Relationships: ${summary.stats.relationships}`,
    `Top functions: ${summary.functionNames.slice(0, 15).join(", ") || "(none)"}`,
    `Endpoints: ${summary.endpoints.slice(0, 15).join(", ") || "(none)"}`,
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
