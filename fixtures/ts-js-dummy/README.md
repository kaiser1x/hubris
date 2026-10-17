# ts-js-dummy fixture (controlled idempotency defect)

Mirrors the controlled `kaiser1x/ts-js-dummy` scenario used by HUBRIS tests.

- File: `src/payments.ts`, function `createPayment()`
- Defect: idempotency keys are recorded but never checked, so a repeated key is accepted.
- Expected error text: `duplicate payment for key`
- Tests: `tests/payments.test.ts`, `tests/idempotency-regression.test.ts`

Test-only data. Never executed by HUBRIS tests; it is analyzed statically.
