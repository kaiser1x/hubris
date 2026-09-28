# Investigation

HUBRIS separates human bug intake from code modification:

```text
USER REPORT
→ NEMOTRON INVESTIGATION AGENT        interpret, decompose, propose queries
→ RAG RETRIEVAL FROM CODETWIN         hybrid, provenance-bound evidence
→ HYPOTHESIS / EVIDENCE SYNTHESIS     model selects cited evidence
→ DETERMINISTIC EVIDENCE VALIDATION   investigate.ts owns the verdict
→ INVESTIGATION RUN                   state + evidence + repair contract
→ USER REVIEW                         READY_FOR_REVIEW → Forge
→ FORGE                               explicit click only
```

## API

`POST /api/investigate` accepts `{ jobId, focus, priorQuestion?, clarification? }`.

- `focus` is the natural-language bug report (≤ 500 chars).
- `priorQuestion`/`clarification` resume a CLARIFICATION_NEEDED run so the
  user never has to restate the whole bug.

The endpoint builds a hybrid retrieval index from the job's persisted CodeTwin
(functions, classes, endpoints, tests, relationships, bounded source/test
facts) plus repository metadata (repo name, ref, commitSha, package manager,
scripts). When a Nemotron model is configured it runs a two-call agent:

1. **Understanding** — observed/expected behavior, entities, actions,
   ambiguities, retrieval queries.
2. **Synthesis** — given bounded retrieved evidence, select the supporting
   evidence unit ids, name a candidate target, and either propose or ask ONE
   focused clarification question.

## Model output is not evidence

Every claim is backed by a retrieval unit `{ sourceType, file, line, function,
text, provenance }`. The model may cite a unit id; ids that do not resolve to
the retrieved index are dropped, and a sufficiency claim with no cited
evidence is rejected. The model never decides READY.

## States

`DRAFT | RETRIEVING | ANALYZING | CLARIFICATION_NEEDED | READY_FOR_REVIEW |
READY | AMBIGUOUS | NO_MATCH`. The coarse `status` (`READY | AMBIGUOUS |
NO_MATCH`) is preserved for existing gating; `state` distinguishes a
reviewable result from one still asking the user a focused question.

## Deterministic validation

`isGroundedRepairContract` / `investigateTwin` remain the gate. A run is READY
only with a target, a relevant scenario, observed and expected behavior,
relevant source evidence, relevant assertions, source-revision consistency,
and no contradictory evidence. When no model is configured, the endpoint
degrades to the deterministic investigator over the same twin.

## Repair contract grounding

The contract preserves concrete evidence. If the relevant test asserts
`expect(order.total).toBe(180)`, the contract carries that exact expectation —
it is never reduced to "the reported value must be computed correctly".
Assertions that invoke a different known twin function (and do not reference
the target, a report subject, or a report behavior concept) are excluded, so
leftover checks in the same `it` block cannot leak in.

## Persistence

Each run is a job `investigationRuns[]` record with `investigationId`, `jobId`,
`focus`, `status`/`state`, the verdict and plan, `observedBehavior`,
`expectedBehavior`, `modelSummary`, `clarification`, `retrievedEvidence`,
`relevantScenarios`, `relevantSourceFacts`, `relevantAssertions`, `modelUsed`,
`createdAt`, and `source` (`{ jobId, repository, ref, commitSha }`). No raw
chain-of-thought is persisted.

## Forge handoff

Investigation never runs repository code, installs dependencies, calls the
sandbox, writes source, or changes the Git working tree. The Forge page loads
the exact persisted investigation by `investigationId` and **never starts a
run automatically**: on load it shows the attached investigation, target,
expected behavior, evidence, repair contract, and source revision, and an
enabled `FORGE FIX IN SANDBOX` button. Refresh does not create a run. If a run
already exists for the exact investigation, its current state is displayed
instead of launching another.

## Reproduce

When the investigation names a relevant test, the Reproduce page proposes a
runner-aware command built from actual repository metadata (package manager +
test script + test file), e.g. `pnpm exec vitest run tests/orders.test.ts
--reporter=verbose`. Reproduction evidence persists `jobId`,
`investigationId`, and `commitSha`.
