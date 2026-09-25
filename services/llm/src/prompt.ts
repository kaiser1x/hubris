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
