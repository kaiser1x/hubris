import type { ForgeRunView, VerifyResult } from "../lib/forge-run";
import { shortCommit, shortRunStatus, targetVerificationMark } from "../lib/forge-run";

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0">
      <dt className="text-[#7A7171]">{label}</dt>
      <dd>{ok ? "✓" : "✕"}</dd>
    </div>
  );
}

function resultLabel(result: VerifyResult): string {
  if (result === "PASS") return "PASS";
  if (result === "FAIL") return "FAIL";
  return "NOT RUN";
}

function MismatchEvidence({ run }: { run: ForgeRunView }) {
  const m = run.mismatch;
  if (!m) return null;
  return (
    <div className="mt-4 border-t border-[#dedada] pt-3">
      <p className="kicker mb-1">Exact-match failure</p>
      <p className="font-mono text-[11px] leading-5 text-[#7A7171]">
        Model oldText {m.oldTextLength} chars · authoritative source{" "}
        {m.sourceLength} chars · only {m.matchingPrefixChars} chars matched
        {m.sourceOffset >= 0 ? ` at source offset ${m.sourceOffset}` : ""}.
      </p>
      {/* Shown as JSON strings so whitespace is exact: spaces are kept, and a
          real line break reads differently from a literal backslash-n. */}
      <p className="font-mono text-[11px] leading-5 text-[#7A7171] mt-1.5">
        Model oldText begins:{" "}
        <code className="text-[#0A0A0A] whitespace-pre-wrap break-all" data-exact-snippet>
          {m.oldTextSnippet ? JSON.stringify(m.oldTextSnippet.slice(0, 120)) : "—"}
        </code>
      </p>
      <p className="font-mono text-[11px] leading-5 text-[#7A7171] mt-1">
        Source at match offset:{" "}
        <code className="text-[#0A0A0A] whitespace-pre-wrap break-all" data-exact-snippet>
          {m.sourceSnippet ? JSON.stringify(m.sourceSnippet.slice(0, 160)) : "—"}
        </code>
      </p>
      <p className="font-mono text-[11px] leading-5 text-[#7A7171] mt-1.5">
        Byte-exact matching is enforced; the edit was not applied.
      </p>
    </div>
  );
}

function OutcomeBanner({ run }: { run: ForgeRunView }) {
  const v = run.verification;
  const assessment = v?.assessment ?? null;
  const summary = run.testSummary ? `${run.testSummary.passed} / ${run.testSummary.total}` : null;

  // Everything passed (assessment-backed).
  if (run.outcome === "FULL_SUITE_PASSED") {
    return (
      <div className="border border-[#0A0A0A] px-5 py-5">
        <p className="font-display text-[34px] leading-none">FULL SUITE PASSED</p>
        <p className="font-mono text-[12px] mt-3">Repair applied and all tests passed.</p>
        <p className="font-mono text-[12px] mt-1.5 text-[#7A7171]">
          {summary ? `${summary} tests passed` : "tests passed"} · exit {v?.exitCode ?? "—"} ·{" "}
          {v?.timedOut ? "timed out" : "no timeout"}
        </p>
      </div>
    );
  }

  // Legacy runs that predate the assessment.
  if (run.outcome === "VERIFIED") {
    return (
      <div className="border border-[#0A0A0A] px-5 py-5">
        <p className="font-display text-[34px] leading-none">VERIFIED</p>
        <p className="font-mono text-[12px] mt-3">Patch applied successfully in sandbox.</p>
        <p className="font-mono text-[12px] mt-1.5 text-[#7A7171]">
          {summary ? `${summary} tests passed` : "tests passed"} · exit {v?.exitCode ?? "—"} ·{" "}
          {v?.timedOut ? "timed out" : "no timeout"}
        </p>
      </div>
    );
  }

  // Patch applied + investigated behavior verified, unrelated suite failures remain.
  if (run.outcome === "REPAIR_VERIFIED") {
    const n = assessment?.unrelatedTestFailures ?? 0;
    return (
      <div className="border-2 border-[#0A0A0A] px-5 py-5">
        <p className="font-display text-[34px] leading-none">REPAIR VERIFIED</p>
        <p className="font-mono text-[12px] mt-3">Target behavior verified.</p>
        {assessment?.targetScenario && (
          <div className="font-mono text-[12px] mt-4">
            <p className="kicker">Target verification</p>
            <p className="mt-1.5">
              ✓ {assessment.targetScenario}
              {assessment.targetTestFile ? (
                <span className="text-[#7A7171]"> · {assessment.targetTestFile}</span>
              ) : null}
            </p>
          </div>
        )}
        <div className="font-mono text-[12px] mt-4">
          <p className="kicker">Regression suite</p>
          <p className="mt-1.5">
            {n} unrelated test{n === 1 ? "" : "s"} failed.
          </p>
        </div>
        <dl className="font-mono text-[12px] mt-4 border-t border-[#dedada]">
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Patch applied</dt>
            <dd>{assessment?.patchApplied ? "✓" : "✕"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Target behavior</dt>
            <dd>{targetVerificationMark(assessment?.targetVerificationPassed)}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Full suite</dt>
            <dd>✗</dd>
          </div>
          <div className="flex justify-between py-1.5">
            <dt className="text-[#7A7171]">Unrelated failures</dt>
            <dd>{n}</dd>
          </div>
        </dl>
        <p className="font-mono text-[11px] mt-3 text-[#7A7171]">
          The repair was applied and the investigated behavior passed. The broader test suite still
          has failures outside the investigated behavior.
        </p>
        {assessment && assessment.failedTests.length > 0 && (
          <div className="font-mono text-[11px] mt-2 text-[#7A7171]">
            <p>Unrelated:</p>
            <ul className="break-all">
              {assessment.failedTests.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // The investigated behavior still fails.
  if (run.outcome === "REPAIR_NOT_VERIFIED") {
    return (
      <div className="border border-[#dedada] px-5 py-5">
        <p className="font-display text-[28px] leading-none">REPAIR NOT VERIFIED</p>
        <p className="font-mono text-[12px] mt-3">The investigated behavior is still failing.</p>
        {assessment?.targetFailure ? (
          <p className="font-mono text-[11px] mt-1.5 text-[#7A7171] break-all">
            Failing target: {assessment.targetFailure}
            {v?.exitCode !== null && v?.exitCode !== undefined ? ` · exit ${v.exitCode}` : ""}
          </p>
        ) : (
          <p className="font-mono text-[11px] mt-1.5 text-[#7A7171]">
            {v?.command ?? "verification"} exited {v?.exitCode ?? "—"}
          </p>
        )}
      </div>
    );
  }

  // Applied, but the failures cannot be attributed.
  if (run.outcome === "VERIFICATION_INCOMPLETE") {
    const couldNotVerifyTarget =
      Boolean(assessment?.targetScenario) && assessment?.targetVerificationPassed === null;
    return (
      <div className="border border-[#dedada] px-5 py-5">
        <p className="font-display text-[24px] leading-none">
          PATCH APPLIED — VERIFICATION INCOMPLETE
        </p>
        <p className="font-mono text-[12px] mt-3 text-[#7A7171]">
          {couldNotVerifyTarget
            ? "HUBRIS could not directly verify the investigated test scenario."
            : "HUBRIS could not determine whether the test failures affect the reported bug."}
        </p>
      </div>
    );
  }

  const titles: Record<string, string> = {
    VERIFICATION_FAILED: "VERIFICATION FAILED",
    VERIFICATION_TIMEOUT: "VERIFICATION TIMED OUT",
    APPLY_FAILED: "PATCH APPLY FAILED",
    VALIDATION_FAILED: "PATCH VALIDATION FAILED",
    SOURCE_MISMATCH: "SOURCE REVISION MISMATCH",
    UNKNOWN: "UNKNOWN STATE",
  };
  const detail =
    run.outcome === "SOURCE_MISMATCH"
      ? "sandbox revision did not match the analyzed revision · patching stopped before apply · Verification: NOT RUN"
      : run.outcome === "APPLY_FAILED"
      ? v
        ? `verification runner exited ${v.exitCode ?? "—"}`
        : "patch rejected before verification · Verification: NOT RUN"
      : run.outcome === "VALIDATION_FAILED"
        ? `backend state ${run.status} · later stages did not run`
        : run.outcome === "VERIFICATION_TIMEOUT"
          ? `${v?.command ?? "verification"} timed out`
          : v
            ? `${v.command} exited ${v.exitCode ?? "—"}${summary ? ` · tests ${summary}` : ""}`
            : "no verification evidence persisted";
  return (
    <div className="border border-[#dedada] px-5 py-5">
      <p className="font-display text-[28px] leading-none">{titles[run.outcome] ?? run.status}</p>
      <p className="font-mono text-[12px] mt-3 text-[#7A7171]">{detail}</p>
      <MismatchEvidence run={run} />
    </div>
  );
}

export default function ForgeRunPanel({ run }: { run: ForgeRunView }) {
  const v = run.verification;
  const a = v?.assessment ?? null;
  // The regression suite is the full repository test command — distinct from
  // the exact target-scenario verification.
  const regressionStatus = a
    ? `${a.fullSuitePassed ? "✓ PASSED" : "✗ FAILED"}${
        a.unrelatedTestFailures > 0
          ? ` · ${a.unrelatedTestFailures} unrelated test${a.unrelatedTestFailures === 1 ? "" : "s"} failed`
          : ""
      }`
    : v
      ? resultLabel(v.result)
      : "—";
  return (
    <article className="border border-[#dedada] bg-white/60">
      <div className="px-5 py-4 border-b border-[#dedada] flex items-baseline gap-3">
        <p className="kicker">
          Forge run · #{run.number}
        </p>
        <span className="font-mono text-[10px] text-[#7A7171]">
          {run.kind === "structured" ? "structured edit" : "unified diff"} · {shortRunStatus(run)}
        </span>
        {run.at && (
          <span className="ml-auto font-mono text-[10px] text-[#7A7171] truncate max-w-[40%]">
            {run.at}
          </span>
        )}
      </div>

      <div className="px-5 py-4">
        <OutcomeBanner run={run} />
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Run sequence</p>
        <dl className="font-mono text-xs">
          {run.steps.map((s) => (
            <div
              key={s.label}
              className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0"
            >
              <dt className={s.reached ? "" : "text-[#7A7171]"}>{s.label}</dt>
              <dd className={s.reached ? "" : "text-[#7A7171]"}>{s.reached ? "✓" : "○"}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Model output</p>
        <dl className="font-mono text-xs">
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Source</dt>
            <dd>{run.modelSource ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Edits</dt>
            <dd>{run.edits.length > 0 ? `${run.edits.length} edit${run.edits.length === 1 ? "" : "s"}` : run.kind === "structured" ? "—" : "n/a · unified diff"}</dd>
          </div>
          {run.edits.map((e) => (
            <div key={e.path} className="flex justify-between py-1.5 border-b border-[#dedada] last:border-b-0">
              <dt className="text-[#7A7171] truncate max-w-[60%]">{e.path}</dt>
              <dd>{e.function ? `${e.function}()` : "—"}</dd>
            </div>
          ))}
        </dl>
        {run.focus && (
          <p className="font-mono text-[11px] text-[#7A7171] mt-2 leading-5">
            Task: {run.focus}
          </p>
        )}
      </div>

      {run.kind === "structured" && (
        <div className="px-5 pb-4">
          <p className="kicker mb-2">Structured edit</p>
          <dl className="font-mono text-xs">
            {run.editChecks.map((c) => (
              <CheckRow key={c.label} label={c.label} ok={c.ok} />
            ))}
          </dl>
        </div>
      )}

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Patch</p>
        <dl className="font-mono text-xs">
          <CheckRow label="Canonical diff generated by HUBRIS" ok={run.patchShaShort !== null} />
          <CheckRow
            label="git diff --check"
            ok={run.kind === "structured" ? run.steps.find((s) => s.label === "Patch validated")?.reached ?? false : run.applyApplied || run.verification !== null}
          />
          <CheckRow
            label="git apply --check"
            ok={run.kind === "structured" ? run.steps.find((s) => s.label === "Patch validated")?.reached ?? false : run.applyApplied || run.verification !== null}
          />
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Bytes</dt>
            <dd>{run.patchBytes ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 last:border-b-0">
            <dt className="text-[#7A7171]">SHA-256</dt>
            <dd>{run.patchShaShort ?? "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Source revision</p>
        <dl className="font-mono text-xs">
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Analysis ref</dt>
            <dd className="truncate max-w-[60%] text-right">{run.source.ref ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Analysis commit</dt>
            <dd>{shortCommit(run.source.analysisCommitSha ?? run.source.commitSha) ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Execution commit</dt>
            <dd>{shortCommit(run.source.executionCommitSha) ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Sandbox reported ref</dt>
            <dd className="truncate max-w-[60%] text-right">{run.source.sandboxRef ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Sandbox reported commit</dt>
            <dd>{shortCommit(run.source.sandboxSha) ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 last:border-b-0">
            <dt className="text-[#7A7171]">Revision match</dt>
            <dd>{run.source.sandboxMatched === null ? "—" : run.source.sandboxMatched ? "✓" : "✕"}</dd>
          </div>
        </dl>
      </div>

      <div className="px-5 pb-4">
        <p className="kicker mb-2">Sandbox</p>
        <dl className="font-mono text-xs">
          {run.sandboxChecks.map((c) => (
            <CheckRow key={c.label} label={c.label} ok={c.ok} />
          ))}
          <div className="flex justify-between py-1.5 border-b border-[#dedada]">
            <dt className="text-[#7A7171]">Image</dt>
            <dd className="truncate max-w-[60%] text-right">{run.sandbox.image ?? "—"}</dd>
          </div>
          <div className="flex justify-between py-1.5 last:border-b-0">
            <dt className="text-[#7A7171]">Files · duration</dt>
            <dd>
              {run.sandbox.files ?? "—"} ·{" "}
              {run.sandbox.durationMs !== null ? `${(run.sandbox.durationMs / 1000).toFixed(1)}s` : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="px-5 pb-5">
        <p className="kicker mb-2">Verification</p>
        {!run.verification || !run.verification.started ? (
          <div>
            <p className="font-mono text-xs text-[#7A7171]">Verification: NOT RUN</p>
            {run.verification?.exitCode !== null && run.verification?.exitCode !== undefined && (
              <p className="font-mono text-[11px] text-[#7A7171] mt-1.5">
                runner exited {run.verification.exitCode} before verification began
              </p>
            )}
          </div>
        ) : (
          <div className="font-mono text-xs">
            {run.verification.assessment?.targetScenario && (
              <div className="pb-3 border-b border-[#dedada]">
                <p className="text-[#7A7171]">Target verification</p>
                <p className="mt-1">
                  {targetVerificationMark(run.verification.assessment.targetVerificationPassed)}{" "}
                  {run.verification.assessment.targetScenario}
                </p>
                {run.verification.assessment.targetTestFile && (
                  <p className="mt-1 text-[10px] text-[#7A7171] break-all">
                    {run.verification.assessment.targetTestFile}
                  </p>
                )}
              </div>
            )}
            <div className="py-3 border-b border-[#dedada]">
              <p className="text-[#7A7171]">Regression suite</p>
              <p className="mt-1">{regressionStatus}</p>
              <p className="mt-1 text-[10px] text-[#7A7171] break-all">
                Command: {run.verification.command}
              </p>
              <p className="mt-1 text-[10px] text-[#7A7171]">
                Exit code: {run.verification.exitCode ?? "—"}
              </p>
            </div>
            <dl className="font-mono text-xs">
              {run.verification.assessment && (
                <>
                  <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                    <dt className="text-[#7A7171]">Patch applied</dt>
                    <dd>{run.verification.assessment.patchApplied ? "✓" : "✕"}</dd>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                    <dt className="text-[#7A7171]">Target behavior</dt>
                    <dd>
                      {run.verification.assessment.targetVerificationPassed === null
                        ? "—"
                        : run.verification.assessment.targetVerificationPassed
                          ? "✓"
                          : "✗"}
                    </dd>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                    <dt className="text-[#7A7171]">Full suite</dt>
                    <dd>{run.verification.assessment.fullSuitePassed ? "PASSED" : "FAILED"}</dd>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                    <dt className="text-[#7A7171]">Unrelated failures</dt>
                    <dd>{run.verification.assessment.unrelatedTestFailures}</dd>
                  </div>
                </>
              )}
              <div className="flex justify-between py-1.5 border-b border-[#dedada]">
                <dt className="text-[#7A7171]">Tests</dt>
                <dd>
                  {run.testSummary ? `${run.testSummary.passed} / ${run.testSummary.total}` : "—"}
                </dd>
              </div>
              <div className="flex justify-between py-1.5 last:border-b-0">
                <dt className="text-[#7A7171]">Timeout</dt>
                <dd>{run.verification.timedOut ? "Yes" : "No"}</dd>
              </div>
            </dl>
          </div>
        )}
        {(run.outputTail.length > 0 || run.errorTail.length > 0) && (
          <details className="mt-3 border border-[#dedada] px-3 py-2">
            <summary className="font-mono text-[11px] cursor-pointer">
              Verification evidence (test output)
            </summary>
            <pre className="font-mono text-[11px] leading-6 mt-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {[...run.outputTail, ...run.errorTail.map((l) => `stderr: ${l}`)].join("\n")}
            </pre>
          </details>
        )}
      </div>
    </article>
  );
}
