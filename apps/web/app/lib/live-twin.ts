import { LAYERS, type TraceStep, type TwinNode } from "./casefile";

export interface LiveFunction {
  id: string;
  name: string;
  path: string;
  line: number;
  column: number;
}

export interface LiveClass {
  id: string;
  name: string;
  path: string;
  line: number;
  column: number;
}

export interface LiveEndpoint {
  path: string;
  method: string;
  file: string;
}

export interface LiveTest {
  name: string;
  path: string;
  file: string;
}

export interface LiveRelationship {
  from: string;
  to: string;
  type: string;
  caller?: string;
}

export interface LiveStats {
  packages: number;
  functions: number;
  classes: number;
  endpoints: number;
  tests: number;
  relationships: number;
  analysisMs: number;
}

export interface LiveJobResult {
  jobId: string;
  ref?: string;
  commitSha?: string;
  packageManager?: "pnpm" | "npm" | null;
  scripts?: Record<string, string>;
  repository: { id: string; name: string; analysisStatus: string };
  stats: LiveStats;
  sample: { functions: LiveFunction[]; endpoints: LiveEndpoint[] };
  full?: {
    functions: LiveFunction[];
    classes: LiveClass[];
    endpoints: LiveEndpoint[];
    tests: LiveTest[];
    relationships: LiveRelationship[];
    sourceFacts?: Array<{
      path?: string;
      line?: number;
      kind?: "source" | "test";
      text?: string;
    }>;
  };
  // Persisted Forge evidence. Unknown by design: the forge-run mapper
  // validates every entry before display, so the page never renders
  // unvalidated backend shapes.
  forgeRuns?: unknown[];
  draftRejections?: unknown[];
  investigationRuns?: unknown[];
  verifications?: Array<{ passed?: boolean; exitCode?: number | null; [key: string]: unknown }>;
  reproductions?: Array<{ exitCode?: number | null; [key: string]: unknown }>;
}

export interface LiveJob {
  id: string;
  repoUrl: string;
  status: string;
  result: LiveJobResult | null;
  error: string | null;
}

function relativize(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/");
}

function layerFor(file: string): string {
  const f = file.toLowerCase();
  if (/(route|controller|api|endpoint|handler)/.test(f)) return "API";
  if (/(service)/.test(f)) return "Services";
  if (/(queue|messag|bus|topic|event)/.test(f)) return "Messaging";
  if (/(worker|job|cron)/.test(f)) return "Workers";
  if (/(repo|model|db|stor|schema|migrat|dao)/.test(f)) return "Data";
  return "Services";
}

function assertLayer(layer: string): string {
  return (LAYERS as readonly string[]).includes(layer) ? layer : "Services";
}

function unique(items: string[], cap = 5): string[] {
  return [...new Set(items.filter(Boolean))].slice(0, cap);
}

export function twinToNodes(job: LiveJob): TwinNode[] {
  const full = job.result?.full;
  if (!full) return [];
  const { functions, classes, endpoints, tests, relationships } = full;

  const byName = new Map<string, string>();
  for (const fn of functions) byName.set(fn.name, fn.name);
  for (const cls of classes) byName.set(cls.name, cls.name);

  const callsFrom = new Map<string, string[]>();
  const calledBy = new Map<string, string[]>();
  const importsFrom = new Map<string, string[]>();
  const testsFor = new Map<string, string[]>();
  const pushTo = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };

  for (const rel of relationships) {
    if (rel.type === "CALLS") {
      pushTo(callsFrom, rel.from, byName.get(rel.to) ?? rel.to);
      pushTo(calledBy, rel.to, relativize(rel.from));
    } else if (rel.type === "IMPORTS") {
      pushTo(importsFrom, rel.from, rel.to);
    } else if (rel.type === "TESTS") {
      pushTo(testsFor, rel.from, rel.to);
      pushTo(testsFor, rel.to, relativize(rel.from));
    }
  }

  const testsByFile = new Map<string, string[]>();
  for (const t of tests) pushTo(testsByFile, t.file, t.name);

  const nodes: TwinNode[] = [];
  const countInFile = (file: string) => ({
    functions: functions.filter((f) => f.path === file).length,
    endpoints: endpoints.filter((e) => e.file === file).length,
  });

  for (const e of endpoints) {
    const file = relativize(e.file);
    const counts = countInFile(e.file);
    nodes.push({
      id: `endpoint:${e.method}:${e.path}`,
      label: `${e.method} ${e.path}`,
      kind: "route",
      layer: "API",
      file,
      callers: unique(calledBy.get(e.path) ?? []),
      deps: unique([...(callsFrom.get(e.file) ?? []), ...(importsFrom.get(e.file) ?? [])]),
      tests: unique([...(testsFor.get(e.file) ?? []), ...(testsByFile.get(e.file) ?? [])]),
      impact: {
        routes: 1,
        functions: counts.functions,
        tests: testsFor.get(e.file)?.length ?? 0,
        files: 1,
      },
    });
  }

  for (const cls of classes) {
    const file = relativize(cls.path);
    const counts = countInFile(cls.path);
    nodes.push({
      id: `class:${cls.name}:${file}`,
      label: cls.name,
      kind: "class",
      layer: assertLayer(layerFor(cls.path)),
      file,
      callers: unique(calledBy.get(cls.name) ?? []),
      deps: unique([...(callsFrom.get(cls.path) ?? []), ...(importsFrom.get(cls.path) ?? [])]),
      tests: unique([...(testsFor.get(cls.path) ?? []), ...(testsByFile.get(cls.path) ?? [])]),
      impact: {
        routes: counts.endpoints,
        functions: Math.max(counts.functions, 1),
        tests: testsFor.get(cls.path)?.length ?? 0,
        files: 1,
      },
    });
  }

  for (const fn of functions) {
    const file = relativize(fn.path);
    const counts = countInFile(fn.path);
    nodes.push({
      id: `function:${fn.name}:${file}`,
      label: fn.name,
      kind: "function",
      layer: assertLayer(layerFor(fn.path)),
      file,
      callers: unique(calledBy.get(fn.name) ?? []),
      deps: unique([...(callsFrom.get(fn.path) ?? []), ...(importsFrom.get(fn.path) ?? [])]),
      tests: unique([...(testsFor.get(fn.path) ?? []), ...(testsByFile.get(fn.path) ?? [])]),
      impact: {
        routes: counts.endpoints,
        functions: Math.max(counts.functions, 1),
        tests: testsFor.get(fn.path)?.length ?? 0,
        files: 1,
      },
    });
  }

  return nodes;
}

export function liveHealth(job: LiveJob): [string, string, string][] {
  const stats = job.result?.stats;
  if (!stats) return [];
  return [
    ["Functions mapped", String(stats.functions + stats.classes), `${stats.endpoints} endpoints`],
    ["Relationships", String(stats.relationships), "traced across files"],
    ["Tests found", String(stats.tests), "linked to nodes"],
  ];
}

export function liveRepoName(job: LiveJob): string {
  return job.result?.repository.name ?? job.repoUrl.split("/").slice(-2).join("/").replace(/\.git$/, "");
}

async function fetchJobs(url: string): Promise<LiveJob[]> {
  // Bound the wait: a hung API/DB must resolve to an empty list, never
  // leave a page on its loading gate forever.
  // Dev-safe diagnostics: status + elapsed only, never bodies or secrets.
  const t0 = Date.now();
  console.log("OVERVIEW_FETCH_START", url.split("?")[0]);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    console.log("OVERVIEW_FETCH_STATUS", res.status, `${Date.now() - t0}ms`);
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = Array.isArray(data.jobs) ? (data.jobs as LiveJob[]) : [];
    console.log("OVERVIEW_FETCH_SUCCESS", `${jobs.length} jobs`, `${Date.now() - t0}ms`);
    return jobs;
  } catch (e) {
    console.log(
      "OVERVIEW_FETCH_ERROR",
      e instanceof Error && e.name === "TimeoutError" ? "timeout" : "fetch-failed",
      `${Date.now() - t0}ms`
    );
    return [];
  }
}

export async function fetchLatestJob(repoUrl?: string): Promise<LiveJob | null> {
  try {
    const params = new URLSearchParams({ limit: "10" });
    if (repoUrl) params.set("repoUrl", repoUrl);
    const jobs = await fetchJobs(`/api/jobs?${params}`);
    return (
      jobs.find((j) => j.status === "complete" && j.result?.stats && (j.result.stats.functions > 0 || j.result.stats.classes > 0)) ??
      null
    );
  } catch {
    return null;
  }
}

// Recent jobs for Forge evidence selection. One load, caller-triggered
// refresh only — never polled. Returns [] on any failure so the page can
// render its empty state instead of hanging.
export async function fetchRecentJobs(limit = 10): Promise<LiveJob[]> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    return await fetchJobs(`/api/jobs?${params}`);
  } catch {
    return [];
  }
}

export async function fetchJobById(jobId: string): Promise<LiveJob | null> {
  if (!jobId) return null;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as LiveJob;
    return data && typeof data.id === "string" ? data : null;
  } catch {
    return null;
  }
}

// The exact view-model the Overview loading gate resolves: live content for
// a valid completed job, null for everything else (job missing, empty twin,
// malformed shape). Never throws, so no failure path can wedge the UI on
// "Loading twin…". Extracted pure for deterministic regression tests.
export interface LiveOverview {
  nodes: TwinNode[];
  name: string;
  cells: [string, string, string][];
}

export function resolveLiveOverview(job: LiveJob | null): LiveOverview | null {
  // Same gate as fetchLatestJob's selection: a twin with no functions or
  // classes is not live content, even if stray nodes could be derived.
  const stats = job?.result?.stats;
  if (!stats || (stats.functions <= 0 && stats.classes <= 0)) return null;
  try {
    const nodes = twinToNodes(job);
    if (nodes.length === 0) return null;
    return { nodes, name: liveRepoName(job), cells: liveHealth(job) };
  } catch {
    return null;
  }
}

// Derive a static call chain from twin CALLS relationships, starting at the
// endpoint with the richest call graph. Timings are unknown without sandbox
// execution, so ms/result are marked as static rather than measured.
export function traceFromTwin(job: LiveJob, maxSteps = 8, entryEndpoint?: LiveEndpoint): TraceStep[] {
  const full = job.result?.full;
  if (!full || full.endpoints.length === 0) return [];

  const callsFromFile = new Map<string, string[]>();
  const callsFromCaller = new Map<string, string[]>();
  for (const rel of full.relationships) {
    if (rel.type !== "CALLS") continue;
    const fileList = callsFromFile.get(rel.from) ?? [];
    if (!fileList.includes(rel.to)) fileList.push(rel.to);
    callsFromFile.set(rel.from, fileList);
    if (rel.caller) {
      const callerList = callsFromCaller.get(rel.caller) ?? [];
      if (!callerList.includes(rel.to)) callerList.push(rel.to);
      callsFromCaller.set(rel.caller, callerList);
    }
  }

  // Caller-scoped edges for display. File-level edges are only used to find
  // the next hop, never shown as a function's own calls.

  const funcByName = new Map(full.functions.map((f) => [f.name, f]));
  // Bare-suffix aliases so unqualified references resolve to qualified
  // definitions (inner -> outer.inner), without shadowing exact names.
  for (const [name, fn] of [...funcByName]) {
    const bare = name.split(".").pop() ?? "";
    if (bare !== name && !funcByName.has(bare)) funcByName.set(bare, fn);
  }
  // Resolve dotted handler references (book_controller.index) to defined functions.
  const resolveFunc = (name: string): LiveFunction | undefined => {
    const direct = funcByName.get(name);
    if (direct) return direct;
    const bare = name.split(".").pop() ?? "";
    return bare === name ? undefined : funcByName.get(bare);
  };
  const ranked = [...full.endpoints].sort(
    (a, b) => (callsFromFile.get(b.file)?.length ?? 0) - (callsFromFile.get(a.file)?.length ?? 0)
  );
  const entry =
    (entryEndpoint &&
      full.endpoints.find((e) => e.method === entryEndpoint.method && e.path === entryEndpoint.path)) ??
    ranked[0];

  const steps: TraceStep[] = [];
  const visited = new Set<string>();
  let file: string | null = entry.file;
  const label = `${entry.method} ${entry.path}`;

  steps.push({
    node: `endpoint:${entry.method}:${entry.path}`,
    label,
    detail: "entry point",
    func: "(entry)",
    file: relativize(entry.file),
    line: 1,
    ms: "—",
    result: "static",
  });
  visited.add(`endpoint:${entry.method}:${entry.path}`);
  const entryId = `endpoint:${entry.method}:${entry.path}`;

  // Traversal rule: follow a function's own recorded calls. File-level calls
  // are only a fallback for twins recorded before caller attribution existed
  // (no caller fields at all). An empty own-call set is a leaf — the walk
  // never backtracks into skipped branches.
  const hasCallerData = full.relationships.some((r) => r.caller);
  let func: string | null = null;
  while (file && steps.length < maxSteps) {
    const scoped =
      (func ? callsFromCaller.get(func) : callsFromCaller.get(entryId)) ?? [];
    const pool =
      scoped.length > 0 || hasCallerData
        ? scoped
        : (callsFromFile.get(file) ?? []);
    const fileCallees: string[] = pool;
    // Follow the first callee defined in the twin; skip external/builtin calls.
    const next: string | undefined = fileCallees
      .map((c: string) => resolveFunc(c))
      .filter((f): f is LiveFunction => f !== undefined && !visited.has(`function:${f.name}`))
      .map((f) => f.name)
      .at(0);
    if (!next) break;
    visited.add(`function:${next}`);
    const fn: LiveFunction = resolveFunc(next)!;
    const own: string[] = (callsFromCaller.get(next) ?? []).filter((c) => c !== next);
    steps.push({
      node: `function:${next}`,
      label: next,
      detail: own.length > 0 ? `calls ${own.slice(0, 3).join(", ")}` : "leaf — no further calls",
      func: next,
      file: relativize(fn.path),
      line: fn.line ?? 1,
      ms: "—",
      result: "static",
    });
    func = fn.name;
    file = fn.path;
  }

  return steps;
}
