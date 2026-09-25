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

export const REPO = {
  name: "hubris-demo-ledger",
  branch: "main",
  context: "production",
};

export const NODES: TwinNode[] = [
  {
    id: "controller",
    label: "TransactionController",
    kind: "controller",
    layer: "API",
    file: "src/controllers/transactions.ts",
    callers: ["POST /api/transactions"],
    deps: ["TransactionService", "ValidationService"],
    tests: ["transactions.api.test.ts · 14"],
    impact: { routes: 2, functions: 6, tests: 14, files: 8 },
  },
  {
    id: "service",
    label: "TransactionService",
    kind: "service",
    layer: "Services",
    file: "src/services/transactions.ts",
    callers: ["TransactionController", "RefundWorker"],
    deps: ["TransactionRepository", "Queue", "IdempotencyStore"],
    tests: ["transactions.unit.test.ts · 31", "idempotency.test.ts · 9"],
    impact: { routes: 5, functions: 11, tests: 17, files: 27 },
  },
  {
    id: "queue",
    label: "Queue",
    kind: "queue",
    layer: "Messaging",
    file: "src/queue/index.ts",
    callers: ["TransactionService"],
    deps: ["TransactionWorker"],
    tests: ["queue.integration.test.ts · 6"],
    impact: { routes: 0, functions: 4, tests: 6, files: 9 },
  },
  {
    id: "worker",
    label: "TransactionWorker",
    kind: "worker",
    layer: "Workers",
    file: "src/workers/transactions.ts",
    callers: ["Queue"],
    deps: ["PaymentService", "TransactionRepository"],
    tests: ["worker.test.ts · 11"],
    impact: { routes: 0, functions: 7, tests: 11, files: 12 },
  },
  {
    id: "repo",
    label: "TransactionRepository",
    kind: "repository",
    layer: "Data",
    file: "src/repositories/transactions.ts",
    callers: ["TransactionService", "TransactionWorker"],
    deps: ["PostgreSQL", "IdempotencyStore"],
    tests: ["repository.test.ts · 18"],
    impact: { routes: 5, functions: 9, tests: 18, files: 15 },
  },
  {
    id: "db",
    label: "PostgreSQL",
    kind: "database",
    layer: "Data",
    file: "infra/postgres/*",
    callers: ["TransactionRepository"],
    deps: [],
    tests: ["migrations verified"],
    impact: { routes: 5, functions: 9, tests: 18, files: 15 },
  },
];

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

export const TRACE: TraceStep[] = [
  {
    node: "controller",
    label: "POST /api/transactions",
    detail: "auth and payload validation",
    func: "createTransaction",
    file: "src/controllers/transactions.ts",
    line: 41,
    ms: "3ms",
    result: "202 accepted",
  },
  {
    node: "service",
    label: "TransactionService.create",
    detail: "idempotency guard check",
    func: "create",
    file: "src/services/transactions.ts",
    line: 88,
    ms: "11ms",
    result: "guard missed, both pass",
  },
  {
    node: "queue",
    label: "Queue.publish",
    detail: "tx.created event",
    func: "publish",
    file: "src/queue/index.ts",
    line: 52,
    ms: "4ms",
    result: "2 events enqueued",
  },
  {
    node: "worker",
    label: "TransactionWorker.handle",
    detail: "charge and settle",
    func: "handle",
    file: "src/workers/transactions.ts",
    line: 117,
    ms: "86ms",
    result: "charged twice",
  },
  {
    node: "repo",
    label: "TransactionRepository.write",
    detail: "persist and mark processed",
    func: "write",
    file: "src/repositories/transactions.ts",
    line: 64,
    ms: "9ms",
    result: "2 rows written",
  },
  {
    node: "db",
    label: "PostgreSQL commit",
    detail: "exactly one row expected",
    func: "commit",
    file: "infra/postgres/tx.sql",
    line: 12,
    ms: "6ms",
    result: "2 rows committed",
  },
];

export interface Case {
  id: string;
  title: string;
  file: string;
  line: number;
  status: "INVESTIGATING" | "REVIEWING" | "VERIFIED";
  meta: string;
}

export const CASES: Case[] = [
  {
    id: "case-031",
    title: "Duplicate transaction on concurrent requests",
    file: "src/services/transactions.ts",
    line: 88,
    status: "INVESTIGATING",
    meta: "6 traces · 2 reproductions · 1 suspected regression",
  },
  {
    id: "case-030",
    title: "Settlement slow on cold start",
    file: "src/workers/transactions.ts",
    line: 117,
    status: "REVIEWING",
    meta: "2 traces · 1 reproduction",
  },
  {
    id: "case-027",
    title: "Stale idempotency cache entry",
    file: "src/services/idempotency.ts",
    line: 39,
    status: "VERIFIED",
    meta: "3 traces · verified patch",
  },
];

export const EVIDENCE = [
  "Duplicate reproduction succeeded in sandbox: 2 concurrent requests produced 2 rows.",
  "Worker execution path confirmed via trace.",
  "Missing pre-write idempotency guard in TransactionService.",
  "Related async refactor found in git history, 3 commits back.",
];

export const VERIFICATION: [string, string][] = [
  ["Original bug", "pass"],
  ["Regression test", "pass"],
  ["Unit tests", "428 / 428 pass"],
  ["Integration tests", "62 / 62 pass"],
  ["Typecheck", "pass"],
  ["Lint", "pass"],
];

export const FORGE = {
  current: ["refreshToken()", "validateSession()", "saveSession()"],
  proposed: ["refreshToken()", "saveSession()", "validateSession()"],
  why: "Moves session persistence before validation, so a concurrent request sees the processed marker instead of racing past the guard.",
  files: ["src/services/transactions.ts"],
  impact: [
    ["Files", "1"],
    ["Functions", "2"],
    ["Execution paths", "3"],
  ] as [string, string][],
};

export const VERIFY_SEQUENCE: [string, string][] = [
  ["Patch", "Applied"],
  ["Reproduction", "Passed"],
  ["Regression tests", "18 / 18 passed"],
  ["Typecheck", "Passed"],
  ["Lint", "Passed"],
  ["Verification", "Confirmed"],
];

export const HEALTH: [string, string, string][] = [
  ["Files analyzed", "31", "across 5 layers"],
  ["Execution paths", "06", "traced end to end"],
  ["Active cases", "03", "1 needs attention"],
  ["Tests passing", "490", "428 unit plus 62 integration"],
];

export const STAGES = [
  "UNDERSTAND",
  "TRACE",
  "INVESTIGATE",
  "REPRODUCE",
  "FORGE",
  "VERIFY",
  "SHIP",
] as const;

export type Stage = (typeof STAGES)[number];
