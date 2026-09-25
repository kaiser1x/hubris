import { LAYERS, type TwinNode } from "./casefile";

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
  repository: { id: string; name: string; analysisStatus: string };
  stats: LiveStats;
  sample: { functions: LiveFunction[]; endpoints: LiveEndpoint[] };
  full?: {
    functions: LiveFunction[];
    classes: LiveClass[];
    endpoints: LiveEndpoint[];
    tests: LiveTest[];
    relationships: LiveRelationship[];
  };
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
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.jobs) ? (data.jobs as LiveJob[]) : [];
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
