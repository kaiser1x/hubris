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

## Clarification

A clarification is asked **only** when materially different, evidence-grounded
interpretations remain, and never about implementation details.

- **A current-vs-expected difference is the bug, not a contradiction.** The
  report is parsed sentence by sentence: the expectation is the `should / must /
  expected` clause (or the text after `instead of`) of a non-directive sentence.
  Investigation instructions ("Investigate why…", "Do not guess…", "Preserve the
  existing error messages") are never read as expectations. A report is
  contradictory only when one expectation clause both demands and rejects the
  same outcome with nothing sequencing it ("accept the *first* request and
  reject the *second*" is not a contradiction).
- **Choices are existing test scenarios** from the retrieved evidence, with
  stable ids (`opt_…`, derived from file + scenario + function) and a stable
  question id (`q_…`). Model-written questions and options are ignored: the
  model selects evidence; it does not author what the user is asked.
- **At least two viable scenarios are required.** With fewer, or when the
  report is contradictory, the run returns `state: AMBIGUOUS` with a specific
  `blocked: { code, reason, nextStep }` instead of a question no answer can fix.
- **Answers are authoritative.** `POST /api/investigate` accepts
  `{ focus, priorInvestigationId, answer: { questionId, optionId } }`. The API
  resolves the option from the *persisted* prior question of the same job and
  rejects (without calling the model or persisting anything) an unknown option
  (400), a stale question, a changed description, an unknown or other-job prior
  run, or an already-answered question (409, `state: STALE_CLARIFICATION`).
  The selected scenario and the function it exercises are pinned to the front
  of the evidence the contract is built from, and the answer (`answer`,
  `selections`, `askedOptionSets`) is persisted on the new run so retries carry
  it. The legacy free-text `priorQuestion`/`clarification` fields remain a hint
  for the model prompts and retrieval only.
- **No equivalent question twice.** The option-set key of every asked question
  is carried through the conversation; asking the same set again — or any
  question after an answer was applied — yields a blocked state
  (`REPEATED_QUESTION` / the specific evidence gap).

Blocked codes: `CONTRADICTORY_REPORT`, `NO_TEST_SCENARIO`,
`SCENARIO_DOES_NOT_EXERCISE_TARGET`, `SCENARIO_ASSERTS_NOTHING`,
`CONTRACT_NOT_GROUNDED`, `TARGET_UNRESOLVED`, `EVIDENCE_UNRESOLVED`,
`REPEATED_QUESTION`.

## Causal evidence ordering

The repair contract's operation/condition come from the **target function's own
facts first**; callee facts follow. Line numbers only order facts within a file
(comparing line numbers across files let an unrelated helper's early line win).

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

A failing command is `REPRODUCED` only when the **investigated scenario** is
what failed (its name on a failing line, or its test file when no scenario was
named). A different failing test is `UNRELATED_FAILURE`; a runner that found no
tests or failed to load a module is `EXECUTION_FAILED`. A run not bound to an
investigation is still reported but flagged `demonstrated: null` ("not tied to
an investigated scenario").
