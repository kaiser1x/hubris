export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const apiKey = env.NEBIUS_API_KEY;
  const model = env.NEBIUS_MODEL;
  if (!apiKey || !model) return null;
  return {
    baseUrl: env.NEBIUS_BASE_URL || "https://api.studio.nebius.com/v1",
    apiKey,
    model,
  };
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

// Deterministic model-call failure taxonomy. Every chatComplete failure
// throws ModelError (never a bare fetch/SyntaxError), so callers log one
// stable category and endpoints map deliberately. No retries here.
export type ModelErrorKind =
  | "http"
  | "empty"
  | "timeout"
  | "transport"
  | "parse";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;

  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export async function chatComplete(
  config: LlmConfig,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: options?.maxTokens ?? 500,
        temperature: options?.temperature ?? 0.2,
      }),
      signal: options?.signal,
    });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ModelError("timeout", "Model request timed out");
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new ModelError("transport", `Model transport error: ${msg}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ModelError(
      "http",
      `Model API error: ${response.status} ${body.slice(0, 200)}`,
      response.status
    );
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
  } catch {
    throw new ModelError("parse", "Model API returned malformed JSON");
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new ModelError("empty", "Model API returned no content");
  return content;
}
