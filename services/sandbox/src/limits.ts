// Phase D — explicit execution limits (brief Phase 6, first consumable slice).
//
// Every sandbox command must have bounded runtime, bounded output, and a
// bounded wait. These knobs are env-configurable with conservative defaults
// and are wired into spawn/run payloads by the API handlers.
//
// Limits that only make sense once an agent loop exists (MAX_AGENT_STEPS,
// MAX_HYPOTHESES, MAX_SANDBOX_RUNS, MAX_RETRIES) are deliberately NOT here:
// no such loop exists yet, and dead knobs hide real policy. They land with
// the loop. Repository transfer guards (MAX_REPOSITORY_SIZE/MAX_FILE_COUNT)
// already live in apps/api checkout limits.

export interface ExecutionLimits {
  // Spawn `timeout`: max execution seconds enforced server-side.
  commandTimeoutS: number;
  // Client poll budget for waitOperation.
  waitMs: number;
  // Spawn `truncate_output_at`: max recorded bytes per stream, server-side.
  maxOutputBytes: number;
  // Spawn `resources_limits.max_layer_bytes`. Unset = server default.
  maxLayerBytes?: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  commandTimeoutS: 120,
  waitMs: 150000,
  maxOutputBytes: 1_048_576,
};

export function executionLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ExecutionLimits {
  const timeout = Number(env.HUBRIS_SANDBOX_TIMEOUT);
  const wait = Number(env.HUBRIS_SANDBOX_WAIT_MS);
  const out = Number(env.HUBRIS_MAX_OUTPUT_BYTES);
  const layer = Number(env.HUBRIS_MAX_LAYER_BYTES);
  return {
    commandTimeoutS:
      Number.isFinite(timeout) && timeout > 0
        ? Math.floor(timeout)
        : DEFAULT_EXECUTION_LIMITS.commandTimeoutS,
    waitMs:
      Number.isFinite(wait) && wait > 0
        ? Math.floor(wait)
        : DEFAULT_EXECUTION_LIMITS.waitMs,
    maxOutputBytes:
      Number.isFinite(out) && out > 0
        ? Math.floor(out)
        : DEFAULT_EXECUTION_LIMITS.maxOutputBytes,
    ...(Number.isFinite(layer) && layer > 0 ? { maxLayerBytes: Math.floor(layer) } : {}),
  };
}
