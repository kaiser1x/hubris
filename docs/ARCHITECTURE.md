# HUBRIS Architecture

Canonical source of truth for how HUBRIS is built **today**. Every diagram
reflects the implementation in this repository — nothing here is aspirational.
Intended future work lives only in [15. Future Architecture](#15-future-architecture),
explicitly labeled.

Conventions: boxes marked `CURRENT` exist and run. Boxes marked `FUTURE` do
not exist yet. See [14. Current Limitations](#14-current-limitations).

## 1. System Overview

```mermaid
flowchart TD
    User(["User (browser)"])
    Web["Next.js Web :3000<br/>live twin UI + demo fallback"]
    API["Hono API :3001<br/>validate, analyze, persist, reason"]
    Analyzer["services/analyzer<br/>static TypeScript analysis"]
    DB[("PostgreSQL 17 :5433<br/>jobs table")]
    LLM["services/llm<br/>OpenAI-compatible chat + prompts"]
    Model["Nemotron via Nebius<br/>investigate + forge"]
    Sandbox["services/sandbox<br/>ConTree REST client"]
    Infra["Nebius sandbox infrastructure"]

    User --> Web
    Web --> API
    API --> Analyzer
    API --> DB
    API --> LLM
    LLM --> Model
    API --> Sandbox
    Sandbox --> Infra

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef store fill:#dbe4ff,stroke:#3b5bdb,color:#10215c
    classDef ext fill:#e9ecef,stroke:#868e96,color:#343a40
    class Web,API,Analyzer,LLM,Sandbox live
    class DB store
    class User,Model,Infra ext
```

Dependency direction is strict: `apps/api` imports the four services.
Services never import each other or the apps (verified by import audit).

## 2. Monorepo Structure

```mermaid
flowchart LR
    Root["hubris/ — pnpm 10.34.5 + turbo, Node 24"]
    Apps["apps/"]
    Web["web/ — Next.js 16"]
    Api["api/ — Hono"]
    Services["services/"]
    Analyzer["analyzer/ — @hubris/analyzer"]
    Db["db/ — @hubris/db"]
    Llm["llm/ — @hubris/llm"]
    Sbx["sandbox/ — @hubris/sandbox"]
    Pkgs["packages/<br/>config, types (stubs)"]
    Fix["fixtures/<br/>demo-repo, deep-chain"]
    Infra2["docker-compose.yml<br/>CI workflow"]

    Root --> Apps
    Apps --> Web
    Apps --> Api
    Root --> Services
    Services --> Analyzer
    Services --> Db
    Services --> Llm
    Services --> Sbx
    Root --> Pkgs
    Root --> Fix
    Root --> Infra2

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef future fill:#ffec99,stroke:#e67700,color:#4d3800
    class Root,Apps,Web,Api,Services,Analyzer,Db,Llm,Sbx,Fix,Infra2 live
    class Pkgs future
```

## 3. Dependency Direction

```mermaid
flowchart TD
    Api2["apps/api"]
    Analyzer2["@hubris/analyzer<br/>main/types: dist/"]
    Db2["@hubris/db<br/>main/types: dist/"]
    Llm2["@hubris/llm<br/>main/types: dist/"]
    Sbx2["@hubris/sandbox<br/>main/types: dist/"]

    Api2 --> Analyzer2
    Api2 --> Db2
    Api2 --> Llm2
    Api2 --> Sbx2

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    class Api2,Analyzer2,Db2,Llm2,Sbx2 live
```

Workspace packages resolve through **compiled `dist` entrypoints**, which do
not exist on a fresh checkout. Therefore `turbo.json` declares
`dependsOn: ["^build"]` for `typecheck` and `test`, so declarations are
emitted before dependents consume them.

## 4. Repository Ingestion

Flow for `POST /api/analyze` with body `repoUrl`:

```mermaid
flowchart TD
    Req["POST /api/analyze"]
    Zod["zod shape check<br/>400 on invalid JSON / missing repoUrl"]
    Safe["toSafeCloneUrl<br/>only https://github.com/owner/repo<br/>400 otherwise"]
    Insert["insert jobs row<br/>id = crypto.randomUUID, status = pending"]
    DbFail["500 job store unavailable<br/>no dangling job"]
    Clone["git clone --depth 1<br/>os.tmpdir/hubris-jobId, 90s timeout"]
    NoExec["No repository code is executed"]
    Analyze["analyzeRepository tmp dir"]
    Norm["normalize absolute temp paths<br/>to repo-relative paths"]
    Store["store full twin<br/>status complete"]
    Slim["respond stats + 10-item sample"]
    Clean["delete temp dir in finally"]
    Fail["mark job failed<br/>respond 500"]

    Req --> Zod
    Zod --> Safe
    Safe --> Insert
    Insert --> DbFail
    Insert --> Clone
    Clone --> NoExec
    NoExec --> Analyze
    Analyze --> Norm
    Norm --> Store
    Store --> Slim
    Slim --> Clean
    Clone --> Fail
    Analyze --> Fail

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef store fill:#dbe4ff,stroke:#3b5bdb,color:#10215c
    class Req,Zod,Safe,Insert,Clone,NoExec,Analyze,Norm,Store,Slim,Clean,DbFail,Fail live
```

Ingestion vs persistence as a sequence. Note the deliberate split: the HTTP
response is slim, the database keeps everything.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant P as PostgreSQL
    participant G as Git
    participant Z as Analyzer
    participant F as Filesystem (tmp)
    C->>A: POST /api/analyze repoUrl
    A->>A: validate (zod + clone URL)
    A->>P: insert job (pending)
    A->>G: git clone --depth 1
    G->>F: hubris-jobId/
    A->>Z: analyzeRepository(tmp)
    Z-->>A: twin (functions, calls, endpoints...)
    A->>A: normalize paths to repo-relative
    A->>P: store full twin (complete)
    A-->>C: stats + 10-item sample
    A->>F: delete temp dir (finally)
```

## 5. CodeTwin Analyzer

`services/analyzer`, TypeScript Compiler API over `.ts` / `.js` files
(`node_modules`, `dist`, `.git` and build output are skipped):

```mermaid
flowchart TD
    Files["repo files (.ts, .js)"]
    TS["TypeScript Compiler API"]
    Fn["Functions: declarations +<br/>exports.x = fn assignments"]
    Ep["Endpoints: regex over<br/>get-post-put-delete-patch path<br/>both quote styles"]
    Tests["Tests: .test. and .spec. files"]
    Calls["CALLS: scope stack over<br/>named functions, const arrows,<br/>exports assignments, middleware arrays,<br/>inline route callbacks"]
    EScope["synthetic endpoint:METHOD:path<br/>scopes + dotted handler refs"]
    Member["dotted member calls<br/>denylist: console, Math, JSON, Promise..."]
    Imports["IMPORTS: import declarations"]
    Twin["full twin"]

    Files --> TS
    TS --> Fn
    TS --> Ep
    TS --> Tests
    TS --> Calls
    Calls --> EScope
    EScope --> Member
    Member --> Imports
    Imports --> Twin
    Fn --> Twin
    Ep --> Twin
    Tests --> Twin

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef store fill:#dbe4ff,stroke:#3b5bdb,color:#10215c
    class Files,TS,Fn,Ep,Tests,Calls,EScope,Member,Imports live
    class Twin store
```

Known boundary: class/object-literal methods are not function nodes yet
(only their inner calls are tracked). `const X = () => …` arrows are
discovered since the arrow-discovery phase, with `outer.inner` qualification
for nested cases.

## 6. Data Model

Exact persisted structures. `jobs.result` is JSONB carrying the twin.

```mermaid
erDiagram
    JOBS ||--|| TWIN : "result stores"
    JOBS {
        uuid id PK
        text repo_url
        text status
        jsonb result
        text error
        timestamptz created_at
        timestamptz updated_at
    }
    TWIN {
        jsonb repository
        jsonb stats
        jsonb sample
        jsonb full
    }
    FULL ||--|{ FUNCTION : contains
    FULL ||--|{ CODE_CLASS : contains
    FULL ||--|{ ENDPOINT : contains
    FULL ||--|{ TEST : contains
    FULL ||--|{ RELATIONSHIP : contains
    FUNCTION {
        string id
        string name
        string path
        int line
        int column
    }
    CODE_CLASS {
        string id
        string name
        string path
        int line
        int column
    }
    ENDPOINT {
        string path
        string method
        string file
    }
    TEST {
        string name
        string path
        string file
    }
    RELATIONSHIP {
        string from
        string to
        string type
        string caller
    }
```

`status` is one of `pending`, `complete`, `failed`. Relationship `type` is
one of `CALLS`, `IMPORTS`, `DEFINES`, `TESTS`, `DEPENDS_ON`. `stats` holds
counts plus `analysisMs`. `sample` holds the first 10 functions and endpoints.
`reproductions` and `verifications` arrays accumulate on `result` as those
flows run.

## 7. Investigate

`POST /api/investigate` with body `jobId, question?`:

```mermaid
flowchart TD
    FE["frontend /investigate"]
    JID["jobId"]
    Load["load job from store<br/>503 no store, 404 unknown,<br/>400 not complete"]
    Cfg["check NEBIUS_* config<br/>503 not configured"]
    Prompt["bounded grounded prompt:<br/>stats, name file:line functions,<br/>METHOD path to handler routes,<br/>cite-only-listed-paths instruction"]
    Chat["chatComplete (60s cap)"]
    Nemo["Nemotron / configured model"]
    Resp["structured answer to frontend"]
    Fail["502 model failure<br/>never silent"]

    FE --> JID
    JID --> Load
    Load --> Cfg
    Cfg --> Prompt
    Prompt --> Chat
    Chat --> Nemo
    Nemo --> Resp
    Chat --> Fail

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef ext fill:#e9ecef,stroke:#868e96,color:#343a40
    class FE,JID,Load,Cfg,Prompt,Chat,Resp,Fail live
    class Nemo ext
```

The answer is model analysis grounded in the stored twin. It is opinion, not
verified truth.

## 8. Forge

`POST /api/forge` with body `jobId, focus?, instruction?`:

```mermaid
flowchart TD
    Job["completed job"]
    Twin2["load stored twin"]
    Cfg2["validate NEBIUS_* config"]
    Prompt2["bounded grounded prompt:<br/>up to 40 functions, 40 relationships,<br/>exact PATCH-TEST-WHY contract"]
    Chat2["chatComplete (1200 tokens, 90s cap)"]
    Nemo2["Nemotron / configured model"]
    Out["PATCH + TEST + WHY"]
    Unver["verified false<br/>sandbox verification pending"]

    Job --> Twin2
    Twin2 --> Cfg2
    Cfg2 --> Prompt2
    Prompt2 --> Chat2
    Chat2 --> Nemo2
    Nemo2 --> Out
    Out --> Unver

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef warn fill:#ffec99,stroke:#e67700,color:#4d3800
    classDef ext fill:#e9ecef,stroke:#868e96,color:#343a40
    class Job,Twin2,Cfg2,Prompt2,Chat2,Out live
    class Unver warn
    class Nemo2 ext
```

Forge output is a **proposal only**. Nothing is applied, and verification does
not exist yet (see section 9).

## 9. Sandbox Boundary

This section is deliberately honest about what runs where today.

```mermaid
flowchart TD
    subgraph CURRENT ["CURRENT — implemented"]
        Forge["forge proposals"]
        Repro["POST /api/reproduce<br/>caller scripts only"]
        Verif["POST /api/verify<br/>caller scripts only"]
        Client["services/sandbox<br/>ConTree REST client"]
        Nebius["Nebius sandbox infrastructure<br/>disposable runs, exit + streams stored"]
        Forge --> Client
        Repro --> Client
        Verif --> Client
        Client --> Nebius
    end
    subgraph FUTURE ["FUTURE — not yet implemented"]
        direction TB
        Checkout["repository checkout upload"]
        Install["install dependencies"]
        RunTests["run tests"]
        Repro2["reproduce"]
        Patch["patch"]
        Verify2["verify"]
        Ship["earned confidence to ship"]
        Checkout --> Install
        Install --> RunTests
        RunTests --> Repro2
        Repro2 --> Patch
        Patch --> Verify2
        Verify2 --> Ship
    end

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef future fill:#ffec99,stroke:#e67700,color:#4d3800
    classDef ext fill:#e9ecef,stroke:#868e96,color:#343a40
    class Forge,Repro,Verif,Client live
    class Checkout,Install,RunTests,Repro2,Patch,Verify2,Ship future
    class Nebius ext
```

Repository code execution through an uploaded checkout is **not implemented**.
Reproduce/verify run caller-provided scripts in disposable sandboxes and store
exit code, stdout, stderr. No production writes exist anywhere.

## 10. Trace Engine

`traceFromTwin()` in `apps/web/app/lib/live-twin.ts`. **Client-side only —
no server-side trace endpoint exists.** Input is the `GET /api/jobs/:id`
payload.

```mermaid
flowchart TD
    Payload["job payload with full twin"]
    FE2["frontend"]
    Engine["traceFromTwin()"]
    Entry["entry: richest endpoint<br/>or user-selected entry"]
    Calls["function-level recorded calls"]
    Dotted["dotted refs resolved<br/>controller.begin to begin"]
    External["externals skipped<br/>require, console.log, unresolved"]
    Cycle["visited-set cycle handling<br/>each node once"]
    Branch["first-defined-in-source-order wins"]
    Leaf["empty own-call set = leaf<br/>never backtrack into skipped branches"]
    Legacy["file-level fallback ONLY<br/>for pre-caller-attribution rows"]
    Cap["8-step hard cap"]
    Render["rendered trace<br/>unknown durations show static"]
    Timings["timings are never invented"]

    Payload --> FE2
    FE2 --> Engine
    Engine --> Entry
    Entry --> Calls
    Calls --> Dotted
    Dotted --> External
    External --> Cycle
    Cycle --> Branch
    Branch --> Leaf
    Leaf --> Legacy
    Legacy --> Cap
    Cap --> Render
    Render --> Timings

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    class Payload,FE2,Engine,Entry,Calls,Dotted,External,Cycle,Branch,Leaf,Legacy,Cap,Render,Timings live
```

Proven adversarially: `fixtures/deep-chain` (branches, a cycle, externals, a
decoy endpoint) yields exactly the predicted 8 steps; suites pin extraction
facts, traversal rules, and the engine-to-API contract.

## 11. Frontend

Next.js 16. Every workspace page follows one pattern:

```mermaid
flowchart TD
    Page["workspace page:<br/>codebase, overview, trace,<br/>investigate, forge,<br/>reproduce, verify, ship"]
    Fetch["fetchLatestJob()"]
    Gate["loading gate"]
    Live["live result"]
    Demo["demo narrative fallback"]
    Page --> Fetch
    Fetch --> Gate
    Gate --> Live
    Gate --> Demo

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    class Page,Fetch,Gate,Live,Demo live
```

All browser API traffic goes through Next proxy routes. The browser never
touches the Hono API directly:

```mermaid
flowchart LR
    Browser["browser"]
    Proxy["Next proxy<br/>apps/web/app/api/*"]
    Hono["Hono API :3001"]
    NoDirect["no direct browser-to-API calls"]

    Browser --> Proxy
    Proxy --> Hono
    Browser -.-> NoDirect

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef note fill:#e9ecef,stroke:#868e96,color:#343a40
    class Browser,Proxy,Hono live
    class NoDirect note
```

Proxy routes exist for `analyze`, `jobs`, `jobs/[id]`, `investigate`,
`forge`, `reproduce`, `verify`.

## 12. Runtime / Infrastructure

```mermaid
flowchart TD
    Dev["developer machine"]
    Pnpm["pnpm 10.34.5"]
    Turbo["turbo monorepo"]
    Web2["apps/web :3000"]
    Api2["apps/api :3001"]
    Pg["PostgreSQL 17 container :5433"]
    Native["native PostgreSQL :5432<br/>untouched"]
    Dev --> Pnpm
    Pnpm --> Turbo
    Turbo --> Web2
    Turbo --> Api2
    Api2 --> Pg
    Pg -.-> Native

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef store fill:#dbe4ff,stroke:#3b5bdb,color:#10215c
    classDef note fill:#e9ecef,stroke:#868e96,color:#343a40
    class Dev,Pnpm,Turbo,Web2,Api2 live
    class Pg store
    class Native note
```

Build order (why `dependsOn: ["^build"]`):

```mermaid
flowchart LR
    Src["workspace package source"]
    Build["build"]
    Dist["compiled dist entrypoints"]
    Check["typecheck / test"]
    Src --> Build
    Build --> Dist
    Dist --> Check

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    class Src,Build,Dist,Check live
```

## 13. CI

`.github/workflows/ci.yml` on push and pull request:

```mermaid
flowchart TD
    Push["git push / PR"]
    GHA["GitHub Actions (ubuntu)"]
    Install["pnpm install --frozen-lockfile"]
    Pg2["PostgreSQL 17 service<br/>migrated jobs table"]
    TC["pnpm typecheck"]
    Test["pnpm test<br/>DB tests run with DATABASE_URL"]
    Build["pnpm build"]

    Push --> GHA
    GHA --> Install
    Install --> Pg2
    Pg2 --> TC
    TC --> Test
    Test --> Build

    classDef live fill:#d3f9d8,stroke:#2b8a3e,color:#0b2e13
    classDef store fill:#dbe4ff,stroke:#3b5bdb,color:#10215c
    class Push,GHA,Install,TC,Test,Build live
    class Pg2 store
```

Locally, DB-backed tests skip when `DATABASE_URL` is unset.

## 14. Current Limitations

Explicit and complete as of this writing. Each item is a tracked engineering
task, not a permanent verdict — the arrow-function limitation previously
listed here was fixed the same way:

- Sandbox **repository execution** (uploaded checkout, install, test) is not
  implemented; reproduce/verify run caller scripts only.
- **No server-side trace endpoint**; traces compute client-side from job data.
- **Method discovery** is incomplete: class and object-literal methods are not
  function nodes yet (their inner calls are tracked).
- **Model output is unverified**: investigation is opinion, forge output is
  labeled `verified: false`.
- Analyzer parses **TypeScript/JavaScript only**; other languages complete
  with empty twins.
- `packages/config` and `packages/types` are reserved stubs.

## 15. Future Architecture

Labeled FUTURE. None of this exists yet:

```mermaid
flowchart TD
    ForgeF["FORGE proposal"]
    Upload["upload repository checkout<br/>to Nebius sandbox"]
    ReproF["sandboxed reproduction"]
    PatchF["apply patch in sandbox"]
    VerifyF["sandboxed patch testing"]
    ShipF["verified autonomous repair<br/>confident shipping workflow"]

    ForgeF --> Upload
    Upload --> ReproF
    ReproF --> PatchF
    PatchF --> VerifyF
    VerifyF --> ShipF

    classDef future fill:#ffec99,stroke:#e67700,color:#4d3800
    class ForgeF,Upload,ReproF,PatchF,VerifyF,ShipF future
```

Entry criteria for each step: live verification against the implementation,
the same standard this document holds throughout.
