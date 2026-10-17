# SHIP

SHIP publishes an already-verified Forge repair as a GitHub pull request:
`POST /api/ship { jobId, forgeRunId, baseBranch? }`. It applies the persisted
canonical patch (never regenerates it), pushes a new `hubris/fix/*` branch, and
opens a PR. It never merges, force-pushes, pulls, or modifies the base branch.

## Three separate questions

| Concept | Question | Compared |
|---|---|---|
| **Source freshness** | Did the exact ref Forge analyzed move since analysis? | remote SHA of that ref (`git ls-remote origin refs/heads/<ref>`) vs the analyzed commit |
| **PR base** | Which branch does the PR merge into? | defaults to the analyzed ref |
| **Base compatibility** | Was the repair validated against that base? | the analyzed ref is the validated tree; any other base must point at the very same commit |

The repository **default branch is never used as evidence of freshness**. A
repair analyzed on a non-default branch (for example
`hubris/buggy-idempotency`) is fresh as long as *that* ref still points at the
analyzed commit, whatever `main` is.

- **Analyzed ref moved or deleted** → `409`, "Repository changed since this
  repair was verified". Re-run the investigation and Forge.
- **Analyzed ref is a tag** → rejected (`BASE_NOT_VALIDATED`): a PR needs a
  branch base; HUBRIS does not fall back to the default branch.
- **No ref recorded (legacy run)** → the run analyzed the default branch, so the
  default branch is both the source and the base.
- **`baseBranch` given and different from the analyzed ref** → allowed only when
  that branch points at the same commit that was validated; otherwise `409`
  `BASE_NOT_VALIDATED` ("the repair has not been validated against it"). The
  product does not re-run Forge against another base.
- Unsafe ref names are refused (`400 BASE_INVALID`) before any git command.
- An open PR for the same head branch that targets a different base is a
  conflict, not a duplicate to reuse.

The SHIP page shows the real base ("Pull request base") on the confirmation and
on the created PR, and the analyzed ref in the provenance block.

All freshness and base checks run before any push or GitHub write.
