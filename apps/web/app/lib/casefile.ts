// Shared type vocabulary for the CodeTwin UI. This module holds ONLY
// repository-agnostic types and layer vocabulary — no demo data. Every
// node/trace/case value rendered by the UI is derived from the active
// analysis job's persisted twin (see lib/workspace.ts + lib/live-twin.ts).

export interface TwinNode {
  id: string;
  label: string;
  kind: string;
  layer: string;
  file: string;
  callers: string[];
  deps: string[];
  tests: string[];
  impact: { routes: number; functions: number; tests: number; files: number };
}

export const LAYERS = ["API", "Services", "Messaging", "Workers", "Data"];

export interface TraceStep {
  node: string;
  label: string;
  detail: string;
  func: string;
  file: string;
  line: number;
  ms: string;
  result: string;
}

export interface Case {
  id: string;
  title: string;
  file: string;
  line: number;
  status: "INVESTIGATING" | "REVIEWING" | "VERIFIED";
  meta: string;
}