// Local / long-lived Node server entrypoint (`pnpm --filter @hubris/api dev|start`).
//
// This is NOT what Vercel runs: Vercel executes the default export of
// src/app.ts as a function and never starts a listener. Everything that only
// makes sense for a process we start ourselves lives here: loading the
// repo-root .env for local development, and binding a port. In production on
// Vercel, configuration comes from the project's environment variables.

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";
import { EventEmitter } from "node:events";
import { serve } from "@hono/node-server";
import { app } from "./app";
import { watchEventLoop } from "./runtime";

// pnpm runs package scripts with CWD set to the package dir, so resolve
// the repo-root .env explicitly instead of relying on process.cwd().
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  serveFn?: (
    options: { fetch: typeof app.fetch; port: number; hostname: string },
    onListening: (info: { address: string; port: number }) => void
  ) => EventEmitter;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
  watch?: () => void;
}

export function startServer(options: StartOptions = {}): { port: number; hostname: string } {
  const env = options.env ?? process.env;
  const serveFn = options.serveFn ?? ((o, cb) => serve(o, cb));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((m: string) => console.log(m));
  const error = options.error ?? ((m: string) => console.error(m));

  const port = Number(env.PORT) || 3001;
  // All interfaces: a container platform (Render) health-checks from outside.
  const hostname = env.HOST || "0.0.0.0";

  const server = serveFn({ fetch: app.fetch, port, hostname }, (info) => {
    log(`HUBRIS API server listening on ${info.address}:${info.port}`);
  });
  // A listener that cannot bind is a startup failure: say so and exit non-zero
  // so the platform reports a failed start instead of an unanswered port.
  server.on("error", (e: NodeJS.ErrnoException) => {
    error(`[hubris] server failed to start: ${e.code ?? e.message}`);
    exit(1);
  });

  // Logs any event-loop stall over 1s with the requests in flight.
  (options.watch ?? (() => void watchEventLoop()))();
  return { port, hostname };
}

// Started directly (`node dist/local.js`: Docker CMD, pnpm dev/start). Tests
// import startServer without starting a listener or loading a .env.
if (typeof require !== "undefined" && require.main === module) {
  config({ path: path.join(findRepoRoot(__dirname), ".env") });
  startServer();
}
