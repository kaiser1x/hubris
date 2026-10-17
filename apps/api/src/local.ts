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
import { serve } from "@hono/node-server";
import { app } from "./app";

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

config({ path: path.join(findRepoRoot(__dirname), ".env") });

const port = Number(process.env.PORT) || 3001;

serve({
  fetch: app.fetch,
  port,
});

console.log(`HUBRIS API server running on http://localhost:${port}`);
