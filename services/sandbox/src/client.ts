import { sandboxHeaders, sandboxUrl, type SandboxConfig } from "./config";

export interface SpawnFileRef {
  uuid: string;
  uid?: number;
  gid?: number;
  mode?: string;
}

export interface SpawnRequest {
  command: string;
  image: string;
  shell?: boolean;
  disposable?: boolean;
  timeout?: number;
  cwd?: string;
  // Previously uploaded files to place in the sandbox before the command
  // runs: absolute sandbox path -> file reference (see uploadFile).
  files?: Record<string, SpawnFileRef>;
}

export interface SpawnResponse {
  operationId: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface StreamRepr {
  value?: string;
  encoding?: "ascii" | "base64";
}

function decodeStream(stream?: StreamRepr | null): string {
  if (!stream?.value) return "";
  if (stream.encoding === "base64") {
    return Buffer.from(stream.value, "base64").toString("utf-8");
  }
  return stream.value;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  return `Sandbox API error: ${response.status} ${body.slice(0, 200)}`;
}

export async function spawnInstance(
  config: SandboxConfig,
  req: SpawnRequest
): Promise<SpawnResponse> {
  const response = await fetch(sandboxUrl(config, "/instances"), {
    method: "POST",
    headers: sandboxHeaders(config),
    body: JSON.stringify({
      command: req.command,
      image: req.image,
      shell: req.shell ?? true,
      disposable: req.disposable ?? true,
      ...(req.timeout !== undefined ? { timeout: req.timeout } : {}),
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.files !== undefined ? { files: req.files } : {}),
    }),
  });

  if (response.status !== 201 && !response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as { uuid?: string };
  if (!data.uuid) throw new Error("Sandbox API returned no operation uuid");
  return { operationId: data.uuid };
}

interface OperationStatus {
  state?: string;
  status?: string;
  metadata?: {
    result?: {
      state?: { exit_code?: number | null; timed_out?: boolean };
      stdout?: StreamRepr;
      stderr?: StreamRepr;
    };
  };
  result?: {
    state?: { exit_code?: number | null; timed_out?: boolean };
    stdout?: StreamRepr;
    stderr?: StreamRepr;
  };
}

function toRunResult(data: OperationStatus): RunResult | null {
  const result = data.metadata?.result ?? data.result;
  if (!result) return null;
  return {
    exitCode: result.state?.exit_code ?? null,
    stdout: decodeStream(result.stdout),
    stderr: decodeStream(result.stderr),
    timedOut: result.state?.timed_out ?? false,
  };
}

function isTerminal(data: OperationStatus): boolean {
  const state = (data.state ?? data.status ?? "").toUpperCase();
  return ["SUCCESS", "SUCCEEDED", "COMPLETED", "FAILED", "ERROR", "CANCELLED", "TIMEOUT"].includes(state);
}

export async function getOperation(
  config: SandboxConfig,
  operationId: string
): Promise<{ terminal: boolean; result: RunResult | null }> {
  const response = await fetch(sandboxUrl(config, `/operations/${operationId}`), {
    headers: sandboxHeaders(config),
  });
  if (!response.ok) throw new Error(await readError(response));
  const data = (await response.json()) as OperationStatus;
  return { terminal: isTerminal(data), result: toRunResult(data) };
}

export async function cancelOperation(
  config: SandboxConfig,
  operationId: string
): Promise<void> {
  const response = await fetch(sandboxUrl(config, `/operations/${operationId}`), {
    method: "DELETE",
    headers: sandboxHeaders(config),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function waitOperation(
  config: SandboxConfig,
  operationId: string,
  options?: { timeoutMs?: number; pollMs?: number }
): Promise<RunResult> {
  const timeoutMs = options?.timeoutMs ?? 120000;
  const pollMs = options?.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { terminal, result } = await getOperation(config, operationId);
    if (terminal) {
      if (!result) throw new Error("Sandbox operation finished without a result");
      return result;
    }
    if (Date.now() >= deadline) {
      await cancelOperation(config, operationId).catch(() => undefined);
      throw new Error("Timed out waiting for sandbox operation");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface UploadedFile {
  uuid: string;
  sha256: string;
  size: number;
}

// Upload raw file content (POST /v1/files, octet-stream). Returns the
// server-assigned uuid plus sha256/size for integrity checks. The uuid is
// then referenced from SpawnRequest.files to place the file in a sandbox.
export async function uploadFile(
  config: SandboxConfig,
  content: Uint8Array,
  options?: { timeoutMs?: number }
): Promise<UploadedFile> {
  const response = await fetch(sandboxUrl(config, "/files"), {
    method: "POST",
    headers: {
      ...sandboxHeaders(config),
      "Content-Type": "application/octet-stream",
    },
    body: content,
    ...(options?.timeoutMs !== undefined
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  });

  if (response.status !== 201 && !response.ok) {
    throw new Error(await readError(response));
  }
  const data = (await response.json()) as {
    uuid?: string;
    sha256?: string;
    size?: number;
  };
  if (!data.uuid || !data.sha256) {
    throw new Error("Sandbox file upload returned no uuid/sha256");
  }
  return { uuid: data.uuid, sha256: data.sha256, size: data.size ?? -1 };
}

export async function runCommand(
  config: SandboxConfig,
  req: SpawnRequest & { waitMs?: number }
): Promise<RunResult> {
  const { operationId } = await spawnInstance(config, req);
  return waitOperation(config, operationId, { timeoutMs: req.waitMs });
}
