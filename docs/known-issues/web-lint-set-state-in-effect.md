# Known issue: `pnpm lint` fails with 9 `react-hooks/set-state-in-effect` errors

**Status:** open, not fixed. Tracked here so it is understood, not ignored.
**Scope:** `apps/web` only (the only workspace package with a `lint` script).
**Severity:** quality gate, not a runtime defect. No user-visible bug was observed.
**Found:** 2026-10-16, during the pre-deployment reliability audit.

## What fails

```text
pnpm turbo run lint --force          # or: cd apps/web && pnpm exec eslint
```

9 errors, one rule: `react-hooks/set-state-in-effect` ("Calling setState
synchronously within an effect can trigger cascading renders"). The rule ships
with `eslint-config-next@16.3.6` (React Compiler lint set, React 19.2.8).

| # | File | Effect (what it does) | Pattern |
|---|------|------------------------|---------|
| 1 | `app/(workspace)/codebase/page.tsx` | clears `selectedId`/`repoError` when `job?.id` changes | A. reset on identity change |
| 2 | `app/(workspace)/history/page.tsx` | clears entries / sets `loading` before `fetchJobById` | B. async load |
| 3 | `app/(workspace)/investigate/page.tsx` (1st effect) | clears focus/result/error/reviewing when `jobId` changes | A. reset on identity change |
| 4 | `app/(workspace)/investigate/page.tsx` (2nd effect) | `setReviewing(false)` when no `?investigationId`, then loads the saved run | B. async load |
| 5 | `app/(workspace)/reproduce/page.tsx` | resets 6 pieces of state, then loads the saved investigation | A + B |
| 6 | `app/(workspace)/ship/page.tsx` | resets 8 pieces of state, then loads the job | A + B |
| 7 | `app/(workspace)/trace/page.tsx` | resets `selected`/`entryKey` when `job?.id` changes | A. reset on identity change |
| 8 | `app/(workspace)/verify/page.tsx` | derives `history`, `script`, `checkError` from `job` | A. state derived from a prop/context value |
| 9 | `app/components/WorkspaceSwitcher.tsx` | hydrates `removed` from `localStorage` on mount | C. external store read |

## Why it is understood and not a regression

- All 9 exist in the committed code (`6670bbe`). Linting the `HEAD` blobs of all
  8 affected files reproduces every one of them. The audit's own changes left
  the count at 9 (only `reproduce/page.tsx` moved by one line).
- It stayed hidden because **`pnpm lint` was served from the Turbo cache**.
  `turbo.json` declares `inputs: ["src/**/*", ...]` for `lint`, but `apps/web`
  has no `src/` directory (code lives in `app/`), so edits never invalidate the
  cache entry. Earlier "lint passed" statements (including
  `debug_outputs/DIAGNOSIS.md`) were cache replays. Always use `--force`.
- CI (`.github/workflows/ci.yml`) runs `typecheck`, `test`, and `build`, **not
  `lint`**, so nothing fails there.

## What the rule is saying

Each effect calls `setState` synchronously in its body. React renders once with
the stale value, runs the effect, then renders again. The functional impact is
an extra render and, in the reset cases, a one-frame flash of the previous
repository's state after a job switch. The behavior is otherwise correct, and the
pages are covered by the existing unit tests (which test view-models, not
effects). That is also why the fix is deliberately **not** bundled with the
investigation/SHIP work: the effects drive job switching and nothing here can
be verified in a browser from the test suite.

## Proposed fix, by pattern

- **A. Reset on identity change** (#1, #3, #5, #6, #7, part of #8): do not reset
  in an effect. Remount the keyed subtree instead, e.g. render the page body as
  `<InvestigateBody key={jobId} />` (or `key={`${jobId}:${investigationId}`}`)
  so `useState` initial values apply on every job switch. This also removes the
  stale-flash. Highest value, lowest risk, mechanical.
- **B. Async load** (#2, #4, #5, #6): derive `loading` from the data instead of
  setting it (`loading = requestedId && loadedFor !== requestedId`), keep the
  `cancelled` guard, and set state only inside the promise callback (already the
  case for the data itself). Or move to a single `useReducer` per page.
- **C. External store** (#9): read `localStorage` with `useSyncExternalStore`
  (server snapshot `[]`), which also avoids the hydration mismatch the effect
  papers over.
- **Verify (#8)** is derived state: compute `history`/default `script` from
  `job` with `useMemo`, and keep only user edits (`script` override,
  `checkError`) in state keyed by `jobId`.

## Not acceptable as fixes

- Disabling the rule, adding `eslint-disable` comments, or downgrading it to a
  warning. The point of tracking this is that the gate stays honest.
- Rewriting effects without a browser check of job switching (Codebase →
  Investigate → Reproduce → Forge → Ship with two different analyzed repos).

## Exit criteria

1. `cd apps/web && pnpm exec eslint` exits 0 (no new `eslint-disable`).
2. `pnpm turbo run lint --force` exits 0.
3. Manual check: switch between two analyzed repositories on every page above
   and confirm no state from the previous repository is shown.
4. Make the gate real: add `pnpm lint` to `.github/workflows/ci.yml`, and either
   add `app/**/*`, `lib/**/*` to the `lint` task `inputs` in `turbo.json` or drop
   `inputs` for `lint` so the cache cannot mask edits.
5. Delete this file.
