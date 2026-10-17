# Deploying HUBRIS

One repository, three hosted pieces:

| Piece | Where | What it is |
|---|---|---|
| `hubris-api` | **Render** web service (Docker, `render.yaml`) | Hono API (`apps/api`), a long-lived Node server |
| `hubris-web` | **Vercel** project, Root Directory `apps/web` | Next.js UI + server-side proxy routes (`/api/*`) |
| Database | **Neon** Postgres (region `iad1`) | Jobs and their persisted evidence |

The browser only ever talks to `hubris-web`. Its proxy routes call the API
server-side, so API secrets and the API key never reach the browser.

## Why the API is not a Vercel Function

HUBRIS shells out to the `git` binary (clone, `ls-files`, `archive`, `show`,
`apply`, `diff`, `push`; the audited list is in `apps/api/src/gitenv.ts`).
Vercel Functions have no `git` in their runtime — a deployed `/ready` reported
`git.available: false` — so analysis, Reproduce, Forge and SHIP cannot run
there. The API therefore runs as a Docker image that installs git.

`apps/api/src/app.ts` still has `export default app;` (and `apps/api/vercel.json`
still exists), so the API builds as a Vercel Function, but that deployment is
not supported.

## The API on Render

- `apps/api/Dockerfile` — Node 24.19 + `git`; installs and builds only
  `@hubris/api` and its workspace dependencies
  (`pnpm turbo run build --filter=@hubris/api...`), then runs
  `node apps/api/dist/local.js`.
- `apps/api/src/local.ts` — `startServer()` binds Render's `PORT` on
  `0.0.0.0`, logs `HUBRIS API server listening on 0.0.0.0:<port>`, and exits 1
  with the reason if it cannot bind. It loads a repo-root `.env` only for local
  development; the image contains none (`.dockerignore`).
- `render.yaml` — Blueprint: free plan, region `virginia` (next to Neon),
  `branch: main`, `healthCheckPath: /health`, auto-deploy, and a `buildFilter`
  so only API-relevant changes redeploy.

### Environment variables (Render → `hubris-api` → Environment)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **non-pooling** connection string (`POSTGRES_URL_NON_POOLING`). One long-lived process keeps its own small pool. |
| `NEBIUS_API_KEY` | yes | Model + sandbox |
| `NEBIUS_MODEL` | yes | Model id. Keep it identical to local `.env` so local measurements match production. |
| `NEBIUS_PROJECT_ID` | yes | Sandbox project |
| `GITHUB_TOKEN` | for SHIP | Fine-grained token, **contents + pull requests write on the target repository only** |
| `HUBRIS_API_KEY` | **yes** | Shared secret. Every route except `/health` requires header `x-hubris-api-key`. Same value as on `hubris-web`. |
| `HUBRIS_FUNCTION_MAX_DURATION_S` | set by `render.yaml` (`285`) | Render has no request limit, but the web proxy gives up at 290s. Model and sandbox waits are clamped to what is left of 285s, so a slow run ends as a recorded `TIMEOUT` or an explicit 504 from the API, never an abandoned request. |
| `NODE_ENV` | set by `render.yaml` | `production` |
| `HUBRIS_DEMO_*` | optional | Demo limits (see below) |
| `HUBRIS_MAX_REPO_FILES`, `HUBRIS_MAX_REPO_BYTES`, other `HUBRIS_*` limits | optional | See `.env.example` |
| `HUBRIS_GIT_PROBE_REPO` | optional | Public https repo for the diagnostics `ls-remote` step (default `https://github.com/octocat/Hello-World.git`) |

Do **not** set `PORT` (Render sets it) or `VERCEL` (it switches on
Vercel-specific behavior). Mark secrets as secret in Render.

## The web app on Vercel (`hubris-web`)

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Framework Preset | Next.js |
| Install / Build | defaults (Turborepo is detected) — or `pnpm turbo run build --filter=web...` |

| Variable | Required | Notes |
|---|---|---|
| `HUBRIS_API_BASE` | yes | `https://hubris-api.onrender.com` (no trailing slash), Production **and** Preview. **Server-side only**, read by every proxy route per request. Unset falls back to `http://localhost:3001`, which cannot work on Vercel. |
| `HUBRIS_API_KEY` | yes | Same value as the API's, Production **and** Preview. Read only by `apps/web/lib/api-auth.ts`; never `NEXT_PUBLIC`. |
| `HUBRIS_DEMO_MODE` | optional | `on`/`off`. Defaults to **on** when `VERCEL` is set (the public site). |

The Forge, Reproduce, Verify and Investigate proxy routes declare
`maxDuration = 300` (the Hobby maximum) and stop waiting on the API at 290s with
an explicit `504 UPSTREAM_TIMEOUT` instead of a bare platform kill.

## Turborepo environment variables

`turbo.json` declares only what a **task** consumes, using `passThroughEnv`
(available to the task, not hashed into the cache key):

- `test` → `DATABASE_URL` (the DB-backed API tests; Turbo's strict mode would
  otherwise hide it and skip them).
- Builds consume no environment variables: `tsc` builds read none, and every
  Next.js API route is dynamic (reads `HUBRIS_API_BASE` per request).
- `NEBIUS_*`, `GITHUB_TOKEN`, `HUBRIS_API_KEY` are **runtime-only**. A Vercel
  "set on the project but missing from turbo.json" notice for them is expected;
  declaring them on a task would leak secrets into build/test processes that
  never need them. Tests stub them explicitly.

## Long-running work

Each request does its work inside the API process and answers when it is done.

Measured on the controlled repositories (persisted evidence, 53 Forge runs):
sandbox portion p50 16s / max 22s; reproduce ≤ 7s; verify ≤ 7s; regression ≈ 5s;
apply ≤ 16s. Add a clone (seconds) and, for Forge, one model draft (≤ 90s) —
plus at most one redraft when the draft's `oldText` misses the source
byte-for-byte. A demo Forge run (`kaiser1x/ts-js-dummy`) takes ~20s of sandbox
time.

Clone + archive measured locally with the real `cloneAndArchive`
(`git clone --depth 1`, `ls-files`, `git archive`): 16-file repo 0.6s; 46 files
0.7s; `express` (214 files, 0.9 MB) 0.8s; `zod` (742 files, 15 MB) 3.4s;
`vitest` (3,197 files, 36 MB) 8.0s. The checkout ceiling is 5,000 files / 50 MB
of tarball. Analysis on Render Free (~0.1 CPU) is ~10× slower than a desktop:
`zod` takes ~38s.

Worst case is bounded by configuration, not luck:

| Endpoint | Work | Behavior at the 285s budget |
|---|---|---|
| `POST /api/analyze` | clone (≤ 90s) + static analysis (≤ 5,000 source files) | larger repos refused with `413 REPO_TOO_LARGE` before parsing |
| `POST /api/investigate` | ≤ 2 model calls × 60s | within budget |
| `POST /api/reproduce`, `/verify`, `/install`, `/run-tests`, `/regression`, `/apply`, `/checkout`, `/forge-verify` | clone + upload + sandbox wait | sandbox wait clamped to the remaining budget; the command is killed first → recorded `TIMEOUT` |
| `POST /api/forge`, `/forge-structured` | clone + model (≤ 90s, + ≤ 1 redraft) + sandbox | same clamp; a redraft happens only if a model call plus the sandbox still fit; under 60s left → `504 BUDGET_EXHAUSTED` before any upload |
| `POST /api/ship` | git fetch/apply/push + GitHub API | no sandbox; each git call has its own timeout |

The clamp (`apps/api/src/runtime.ts`) keeps 15s in reserve to persist evidence
and answer. A run that does not fit ends as the normal `TIMEOUT` result with
its evidence saved.

**There is no durable background-job layer.** A suite that genuinely needs
longer than the budget reports `TIMEOUT`. If that becomes real, the path is to
split sandbox work into *spawn* (return a run id) and *poll* (a later request
finalizes and persists) — the sandbox client already separates `spawnInstance`
from `waitOperation`. Not built, because the measured workloads do not need it.

## Verifying the runtime (git, temp files, network)

1. **Startup log** — Render → Logs shows
   `HUBRIS API server listening on 0.0.0.0:<port>` on every deploy.
2. **`GET /ready`** (API key required) — database answers within 3s,
   `git --version` runs, integrations configured (booleans only). 200 when
   ready, 503 naming what is missing.
3. **`POST /api/diagnostics/git`** — the full read-only check:

   | Step | Proves |
   |---|---|
   | `version` | `git --version` runs |
   | `ls-remote` | read-only HTTPS to a **public** repo (default `octocat/Hello-World`; override with `HUBRIS_GIT_PROBE_REPO`, https only, no credentials): DNS, TLS, egress, `git-remote-https` |
   | `temp-repo` | `os.tmpdir()` is writable; `git init/add/commit` work |
   | `diff-check` | `git diff` makes a patch; `git diff --check` accepts it |
   | `apply-check` | `git apply --check`, then `git apply --index` reproduces the patch byte-for-byte (SHIP's own proof) |
   | `cleanup` | the temp directory is gone |

   Not a public diagnostics page: **POST only**, requires the API key, caches
   for 30s, uses no token, and never pushes or touches GitHub beyond the
   anonymous `ls-remote`. 200 = all passed; 503 = a step failed, with a `code`
   (`GIT_NOT_FOUND`, `GIT_NETWORK`, `GIT_HTTPS_UNSUPPORTED`, `TMP_NOT_WRITABLE`,
   `GIT_APPLY_FAILED`, `GIT_TIMEOUT`, …) and a `hint`.

   ```powershell
   curl.exe -sS -X POST https://hubris-api.onrender.com/api/diagnostics/git -H "x-hubris-api-key: <key>"
   ```

If git were ever missing, the real endpoints say so instead of blaming the
repository: `503 { code: "GIT_UNAVAILABLE" }`.

## Render Free plan limits

- **Sleeps after 15 minutes idle**; the first request afterwards takes about a
  minute. The demo page and proxies allow for it.
- **~0.1 CPU, 512 MB.** CPU-bound work is slow (see analysis timings above);
  the analyzer yields between files so `/health` keeps answering.
- **750 instance hours per month**; a sleeping service uses none.
- **In-memory state resets on restart or wake** — this includes the demo rate
  limits and daily budget.
- The filesystem is ephemeral; HUBRIS only uses `os.tmpdir()` and deletes it
  per request.

## Deploy steps

1. Merge to `main`; CI (`pnpm install --frozen-lockfile`, typecheck, test,
   build) passes.
2. **API:** Render redeploys automatically when API-relevant files change. Wait
   for Render → Events to show the deploy **Live**, and for the
   `listening on 0.0.0.0` log line. First-time setup: Render → New → Blueprint →
   this repository, then fill in the secrets above.
3. **Web:** Vercel redeploys `hubris-web` from `main`. After changing its
   environment variables, redeploy it.
4. Check `GET /health` (200), then `/ready` and `POST /api/diagnostics/git` with
   the API key (200 from both).
5. Smoke test the public demo in a private window: `/demo` → START THE DEMO →
   Investigate → Reproduce → Forge. A second private window must see an empty
   job list.

## Public evaluator demo

The public site runs in **demo mode** (`HUBRIS_DEMO_MODE`, default on when
`VERCEL` is set). Visitors start at `/demo`. The web server gives each browser
a private session (httpOnly cookie, `proxy.ts`) and marks every API call with
it; the API (`apps/api/src/demo.ts`) then enforces, server-side:

| Rule | Behavior |
|---|---|
| Repository | only `kaiser1x/ts-js-dummy` @ `hubris/buggy-idempotency` (403 `DEMO_RESTRICTED`) |
| Routes | analyze, jobs, investigate, reproduce, verify, forge-structured only (403 `DEMO_ROUTE_DISABLED`) |
| SHIP | always refused for demo sessions (403 `DEMO_SHIP_DISABLED`); shipping needs a direct API call with `HUBRIS_API_KEY` |
| Commands | Reproduce/Verify run only the fixed demo commands; no image/ref/command overrides |
| Isolation | jobs are tagged with the creating session (`result.demoSession`); other sessions get 404 and see only their own jobs |
| Limits | per session and per client: 5 analyses/h, 20 runs/h (client ×2); 2 concurrent steps overall, 1 per session; 150 runs/day (`HUBRIS_DEMO_*`) |

Limits are in-memory on the single Render instance and reset when it
restarts. Operators who need the full product (any repo, SHIP) call the API
directly with `HUBRIS_API_KEY`, or run the web app with `HUBRIS_DEMO_MODE=off`
somewhere private — never on the public site.

## Liveness, readiness and event-loop stalls

- `GET /health` is pure liveness: no database, git, model or network work,
  and no API key. Render's health check uses it.
- `GET /ready` checks dependencies (database with a 3s bound, git, configured
  integrations) and answers 503 when one is missing. It requires the API key.
- `POST /api/analyze` runs the analyzer **inside the API process**. The
  analyzer yields to the event loop between files, so `/health` keeps
  answering during an analysis, and it refuses repositories with more than
  `HUBRIS_MAX_REPO_FILES` source files (default 5000) with
  `413 REPO_TOO_LARGE` before parsing. Before this, analysis was one long
  synchronous block: on Render Free (~0.1 CPU) a few hundred files kept the
  event loop busy for well over 5s, which Render reports as
  "HTTP health check failed (timed out after 5 seconds)".
- Any event-loop stall over 1s is logged as
  `[hubris] event loop blocked ~Nms; in flight: METHOD /path` (method and path
  only). Stalls around 1s are normal on Render Free; anything near 5000ms is a
  regression. Search the Render log for it when a health check times out.
