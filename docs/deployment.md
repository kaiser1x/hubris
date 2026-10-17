# Deploying HUBRIS on Vercel

Two Vercel projects from one repository:

| Project | Root Directory | What it is |
|---|---|---|
| `hubris-web` | `apps/web` | Next.js UI + server-side proxy routes (`/api/*`) |
| `hubris-api` | `apps/api` | Hono API, run as a Vercel Function |

The browser only ever talks to `hubris-web`. Its proxy routes call `hubris-api`
server-side, so API secrets and the API key never reach the browser.

## How the API runs on Vercel

Vercel's Hono integration executes the **default export** of a recognized entry
file as a function ([docs](https://vercel.com/docs/frameworks/backend/hono)).

- `apps/api/src/app.ts` — the Hono app; `export default app;`. This is the only
  recognized entry file in `apps/api` (a test enforces it).
- `apps/api/src/local.ts` — the local Node server (`dotenv` + `@hono/node-server`
  `serve()`), used by `pnpm --filter @hubris/api dev|start`. Vercel never runs it.
- `apps/api/vercel.json` — install/build commands only (below).

Configuration comes from the **Vercel project's environment variables**; `.env`
loading exists only in `local.ts`.

## `hubris-api` project settings

| Setting | Value |
|---|---|
| Root Directory | `apps/api` |
| "Include source files outside of the Root Directory" | **Enabled** (default) — the workspace packages live outside `apps/api` |
| Framework Preset | **Hono** (auto-detected from the `hono` dependency) |
| Install Command | `pnpm install --frozen-lockfile` (also set in `vercel.json`; installs the whole workspace) |
| Build Command | `pnpm turbo run build --filter=@hubris/api...` (also set in `vercel.json`) |
| Output Directory | *(empty — leave default)* |
| Node.js Version | 24.x (matches `.nvmrc`) |
| Fluid compute | On (default) |
| Function Max Duration (Settings → Functions) | **800** on Pro/Enterprise, **300** on Hobby |
| Function Region | the region closest to your Postgres |

`--filter=@hubris/api...` builds `@hubris/api` **and its dependencies** in
dependency order (`analyzer`, `db`, `llm`, `sandbox`, then `api`) and nothing
else — in particular not `web`. Each of those packages now declares
`typescript` itself, so `tsc` resolves on a clean Vercel install.

### Environment variables (`hubris-api`, Production + Preview)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Use a **pooled** Postgres endpoint (serverless instances multiply). Add `?sslmode=require` if your provider needs it. |
| `NEBIUS_API_KEY` | yes | Model + sandbox |
| `NEBIUS_MODEL` | yes | Model id |
| `NEBIUS_PROJECT_ID` | yes | Sandbox project |
| `GITHUB_TOKEN` | for SHIP | Fine-grained token, **contents + pull requests write on the target repository only** |
| `HUBRIS_API_KEY` | **strongly recommended** | Shared secret. When set, every route except `/health` requires header `x-hubris-api-key`. Without it the public API is open: anyone could spend sandbox/model credits and open PRs with `GITHUB_TOKEN`. |
| `HUBRIS_FUNCTION_MAX_DURATION_S` | recommended | Set to the same number as the project's Function Max Duration (`800` or `300`). Sandbox waits and model calls are clamped to what is left of it. Defaults to 300 on Vercel. **On Render** (no platform limit) set it below the web proxy's 290s Forge wait — `render.yaml` sets `285` — so a slow Forge ends as an explicit timeout from the API instead of an abandoned request. |
| `HUBRIS_DB_POOL_MAX` | optional | Per-instance connection cap (default: driver default, 10) |
| `HUBRIS_GIT_PROBE_REPO` | optional | Public https repo for the diagnostics `ls-remote` step (default `https://github.com/octocat/Hello-World.git`) |
| `NEBIUS_BASE_URL`, `NEBIUS_SANDBOX_URL`, `HUBRIS_*` limits | optional | See `.env.example` |

None of these are `NEXT_PUBLIC_*`. Mark them **Sensitive**.

## `hubris-web` project settings

| Setting | Value |
|---|---|
| Root Directory | `apps/web` |
| Framework Preset | Next.js |
| Install / Build | defaults (Turborepo is detected) — or `pnpm turbo run build --filter=web...` |

| Variable | Required | Notes |
|---|---|---|
| `HUBRIS_API_BASE` | yes | `https://<hubris-api>.vercel.app` (no trailing slash). **Server-side only.** If unset it falls back to `http://localhost:3001`, which cannot work on Vercel. |
| `HUBRIS_API_KEY` | if the API sets it | Same value as the API's. Read only by `apps/web/lib/api-auth.ts`; never `NEXT_PUBLIC`. |

The web functions have their own max duration (default 300s). Raise the web
project's Default Max Duration to match the API's if you run long Forge suites.

## Turborepo environment variables

`turbo.json` declares only what a **task** consumes, using `passThroughEnv`
(available to the task, not hashed into the cache key):

- `test` → `DATABASE_URL` (the DB-backed API tests; Turbo's strict mode would
  otherwise hide it and skip them).
- Builds consume no environment variables: `tsc` builds read none, and every
  Next.js API route is dynamic (reads `HUBRIS_API_BASE` per request).
- `NEBIUS_*`, `GITHUB_TOKEN`, `HUBRIS_API_KEY` are **runtime-only**. Vercel's
  "set on the project but missing from turbo.json" notice for them is expected;
  declaring them on a task would leak secrets into build/test processes that
  never need them. Tests stub them explicitly.

## Long-running work

Every request that does real work is a single function invocation, so it is
bounded by the project's Max Duration (Hobby 300s, Pro 800s, extended 1800s
beta — [limits](https://vercel.com/docs/functions/limitations)).

Measured on the controlled repositories (persisted evidence, 53 Forge runs):
sandbox portion p50 16s / max 22s; reproduce ≤ 7s; verify ≤ 7s; regression ≈ 5s;
apply ≤ 16s. Add a clone (seconds) and, for Forge, one model draft (≤ 90s).
These finish far inside 300s.

Clone + archive measured locally with the real `cloneAndArchive`
(`git clone --depth 1`, `ls-files`, `git archive`): 16-file repo 0.6s; 46 files
0.7s; `express` (214 files, 0.9 MB) 0.8s; `zod` (742 files, 15 MB) 3.4s;
`vitest` (3,197 files, 36 MB) 8.0s. The checkout ceiling is 5,000 files / 50 MB
of tarball. Upload to the sandbox (≤ 60s timeout), dependency install and the
test suite run in the sandbox and are not measured here beyond the stored
numbers above; a mid-size repo plausibly needs install 60–180s + suite 60–180s.
A realistic large-repo Forge is therefore ~100s of overhead + install + suite:
**comfortable on Pro (800s), at or beyond the limit on Hobby (300s).**
Use Pro and set both the project's Default Max Duration and
`HUBRIS_FUNCTION_MAX_DURATION_S` to `800`.

Worst case is bounded by configuration, not luck:

| Endpoint | Work | Configured worst case | Behavior at the platform limit |
|---|---|---|---|
| `POST /api/analyze` | clone (≤ 90s) + static analysis | ~100s | within budget |
| `POST /api/investigate` | ≤ 2 model calls × 60s | ~120s | within budget |
| `POST /api/reproduce`, `/verify`, `/install`, `/run-tests`, `/regression`, `/apply`, `/checkout`, `/forge-verify` | clone + upload + sandbox wait (150–660s) | > 800s configured | sandbox wait clamped to the remaining budget; the command is killed first → recorded `TIMEOUT` |
| `POST /api/forge`, `/forge-structured` | clone + model (≤ 90s) + sandbox (≤ 660s) | > 800s configured | same clamp; model signal is also bounded |
| `POST /api/ship` | git fetch/apply/push + GitHub API | seconds typical | no sandbox; each git call has its own timeout |

The clamp (`apps/api/src/runtime.ts`) keeps 15s in reserve to persist evidence
and answer. A run that does not fit ends as the normal `TIMEOUT` result with
its evidence saved, never as a bare platform 504 that loses it.

**There is no durable background-job layer.** Nothing in HUBRIS needs to
continue after the response; a suite that genuinely needs longer than the
function allows will report `TIMEOUT`. If that becomes real, the path is to
split sandbox work into *spawn* (return a run id) and *poll* (a later request
finalizes and persists) — the sandbox client already separates `spawnInstance`
from `waitOperation` — or to use Vercel Workflows. Not built, because the
measured workloads do not need it.

## Verifying the runtime (git, temp files, network)

A green **build** says nothing about the deployed function: the build container
and the function runtime are different images. HUBRIS shells out to the `git`
binary (audited list in `apps/api/src/gitenv.ts`: clone/fetch/checkout/ls-files/
archive in staging; `init`/`fetch`/`ls-remote`/`apply`/`diff`/`commit`/`push` in
SHIP; `show HEAD:<path>` in Forge). Three checks run **inside the running
function**:

1. **Cold-start log** — the first request on each function instance logs one
   line: `[hubris] runtime check: git 2.x is available.` or
   `[hubris] runtime check FAILED: no git binary in this runtime …`. Read it in
   Vercel → Logs. No environment values, tokens, or paths are logged.
2. **`GET /ready`** — shallow: database answers, `git --version` runs,
   integrations configured (booleans).
3. **`POST /api/diagnostics/git`** — the full read-only check:

   | Step | Proves |
   |---|---|
   | `version` | `git --version` runs |
   | `ls-remote` | read-only HTTPS to a **public** repo (default `octocat/Hello-World`; override with `HUBRIS_GIT_PROBE_REPO`, https only, no credentials): DNS, TLS, egress, `git-remote-https` |
   | `temp-repo` | `os.tmpdir()` is writable; `git init/add/commit` work |
   | `diff-check` | `git diff` makes a patch; `git diff --check` accepts it |
   | `apply-check` | `git apply --check`, then `git apply --index` reproduces the patch byte-for-byte (SHIP's own proof) |
   | `cleanup` | the temp directory is gone |

   Not a public diagnostics page: **POST only**, requires `HUBRIS_API_KEY` to be
   configured **and** presented (a keyless deployment on Vercel answers 403),
   caches for 30s, uses no token, and never pushes or touches GitHub beyond the
   anonymous `ls-remote`. 200 = all passed; 503 = a step failed, with a
   `code` (`GIT_NOT_FOUND`, `GIT_NETWORK`, `GIT_HTTPS_UNSUPPORTED`,
   `TMP_NOT_WRITABLE`, `GIT_APPLY_FAILED`, `GIT_TIMEOUT`, …) and a `hint`.

   ```bash
   curl -sS -X POST https://<hubris-api>.vercel.app/api/diagnostics/git \
        -H "x-hubris-api-key: $HUBRIS_API_KEY" | jq
   ```

If git is missing, the real endpoints say so instead of blaming the repository:
`503 { code: "GIT_UNAVAILABLE" }` from analyze/reproduce/forge/…/ship (previously
"Repository clone failed" / "Repository changed since this repair was verified").

> **Open risk — `git` on Vercel Functions.** Vercel's build image has git;
> whether the function runtime does is not documented. This can only be answered
> by a **Preview deployment** and the diagnostics call above. If `version` fails
> with `GIT_NOT_FOUND`, analysis, Reproduce, Forge and SHIP cannot work on
> Vercel Functions as written: host the API on a Node host that provides git
> (the web project stays on Vercel; only `HUBRIS_API_BASE` changes), or replace
> the git calls (a large, safety-critical change to the patch-integrity checks).

## Other limits to know

- Request/response bodies are capped at **4.5 MB** on Vercel Functions. A very
  large repository's persisted twin returned by `GET /api/jobs/:id` could
  exceed it.
- 1,024 file descriptors are shared across concurrent executions — keep
  `HUBRIS_DB_POOL_MAX` small.
- The function filesystem is ephemeral; HUBRIS only uses `os.tmpdir()` and
  deletes it per request.

## Deploy steps

1. Merge/push this branch; confirm `pnpm install --frozen-lockfile`, `pnpm test`,
   `pnpm typecheck`, `pnpm build` pass.
2. **Create `hubris-api`**: Vercel → Add New Project → import the repo →
   Root Directory `apps/api` → leave Include-outside-root enabled → confirm the
   settings table above → add the environment variables → Settings → Functions →
   Default Max Duration → Deploy.
3. Open `https://<hubris-api>.vercel.app/health` (200), then `/ready` and
   `POST /api/diagnostics/git` with header `x-hubris-api-key: <HUBRIS_API_KEY>`.
   Expect 200 from both. **Do this on a Preview deployment first**: it is the
   only way to learn whether the function runtime has git.
4. **Update `hubris-web`**: set `HUBRIS_API_BASE` and `HUBRIS_API_KEY`, redeploy.
5. Smoke test in the UI: Codebase → analyze → Investigate → Reproduce → Forge →
   Ship (create a PR only if you want a real one).

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
