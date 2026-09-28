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
// stable category and endpoints map deliberately.
export type ModelErrorKind =
  | "http"
  | "empty"
  | "timeout"
  | "transport"
  | "parse";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly detail?: ResponseDiagnosis;

  constructor(kind: ModelErrorKind, message: string, status?: number, detail?: ResponseDiagnosis) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

// Empty-content classes for diagnosis (Phase I). Pure inspection of the
// parsed body; safe fields only, never prompt/response text.
export type EmptyClass =
  | "A_empty_string"
  | "B_null_content"
  | "C_absent_content"
  | "D_refusal"
  | "E_tool_calls"
  | "F_reasoning_without_content"
  | "G_empty_choices"
  | "H_malformed"
  | "I_other";

export interface ResponseDiagnosis {
  class: EmptyClass | "CONTENT";
  choicesCount: number | null;
  choiceKeys: string[];
  messageKeys: string[];
  role: unknown;
  contentState: "present" | "empty-string" | "null" | "absent";
  finishReason: unknown;
  refusalPresent: boolean;
  toolCallsPresent: boolean;
  toolCallsCount: number | null;
  reasoningPresent: boolean;
  requestId: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function diagnoseResponse(data: unknown): ResponseDiagnosis {
  const base = {
    choicesCount: null as number | null,
    choiceKeys: [] as string[],
    messageKeys: [] as string[],
    role: undefined as unknown,
    finishReason: undefined as unknown,
    refusalPresent: false,
    toolCallsPresent: false,
    toolCallsCount: null as number | null,
    reasoningPresent: false,
    requestId: null as string | null,
  };
  if (!isRecord(data)) {
    return { ...base, class: "H_malformed", contentState: "absent" };
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      ...base,
      choicesCount: Array.isArray(choices) ? choices.length : null,
      class: "G_empty_choices",
      contentState: "absent",
    };
  }
  const choice = choices[0];
  const choiceKeys = isRecord(choice) ? Object.keys(choice) : [];
  const message = isRecord(choice)
    ? (choice as { message?: unknown }).message
    : undefined;
  const messageKeys = isRecord(message) ? Object.keys(message) : [];
  const msg = isRecord(message) ? (message as Record<string, unknown>) : {};
  const content = msg.content;
  const contentState =
    typeof content === "string" && content.length > 0
      ? ("present" as const)
      : content === ""
        ? ("empty-string" as const)
        : content === null
          ? ("null" as const)
          : ("absent" as const);
  const refusal = msg.refusal;
  const refusalPresent =
    typeof refusal === "string" ? refusal.length > 0 : refusal != null;
  const toolCalls = msg.tool_calls;
  const toolCallsPresent = Array.isArray(toolCalls) && toolCalls.length > 0;
  const reasoning =
    (msg as { reasoning_content?: unknown }).reasoning_content ??
    (msg as { reasoning?: unknown }).reasoning;
  const reasoningPresent =
    typeof reasoning === "string" ? reasoning.length > 0 : reasoning != null;
  const meta = {
    ...base,
    choicesCount: choices.length,
    choiceKeys,
    messageKeys,
    role: msg.role,
    finishReason: isRecord(choice)
      ? (choice as { finish_reason?: unknown }).finish_reason
      : undefined,
    refusalPresent,
    toolCallsPresent,
    toolCallsCount: Array.isArray(toolCalls) ? toolCalls.length : null,
    reasoningPresent,
  };
  if (refusalPresent) return { ...meta, class: "D_refusal", contentState };
  if (toolCallsPresent && contentState !== "present")
    return { ...meta, class: "E_tool_calls", contentState };
  if (reasoningPresent && contentState !== "present")
    return { ...meta, class: "F_reasoning_without_content", contentState };
  if (contentState === "empty-string") return { ...meta, class: "A_empty_string", contentState };
  if (contentState === "null") return { ...meta, class: "B_null_content", contentState };
  if (contentState === "absent") return { ...meta, class: "C_absent_content", contentState };
  return { ...meta, class: "CONTENT", contentState };
}

// Cap for the budget-starvation retry. Reasoning models spend tokens
// thinking before answering; a 4096 budget can be exhausted mid-reasoning
// (finish_reason:length, content:null). The retry doubles the budget up to
// this ceiling so the final content always has room to exist. Two retries
// max in practice (default forge budget 8192 -> 16384).
export const MAX_RETRY_BUDGET = 16384;

// A response with no usable content whose finish_reason is "length" means
// the token budget ran out before the model produced output (mid-reasoning
// for reasoning models, mid-generation otherwise). Retrying with a larger
// budget is the correct recovery; every other empty shape is terminal.
export function isBudgetStarvation(diagnosis: ResponseDiagnosis): boolean {
  return diagnosis.contentState !== "present" && diagnosis.finishReason === "length";
}

async function postCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  options: {
    budget: number;
    temperature?: number;
    signal?: AbortSignal;
    responseFormat?: "text" | "json_object";
  }
): Promise<{ data: unknown; requestId: string | null }> {
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
        max_tokens: options.budget,
        temperature: options.temperature ?? 0.2,
        ...(options.responseFormat !== undefined
          ? { response_format: { type: options.responseFormat } }
          : {}),
      }),
      signal: options.signal,
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

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ModelError("parse", "Model API returned malformed JSON");
  }
  const requestId =
    response.headers?.get("x-request-id") ??
    response.headers?.get("request-id") ??
    response.headers?.get("x-correlation-id") ??
    null;
  return { data, requestId };
}

export async function chatComplete(
  config: LlmConfig,
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    // Verified against the Token Factory OpenAPI contract
    // (ResponseFormat: text | json_object | json_schema). Unset by
    // default: the field is omitted and server behavior is unchanged.
    // Use json_object only for JSON consumers (structured edits) —
    // never for diff/prose generation.
    responseFormat?: "text" | "json_object";
  }
): Promise<string> {
  let budget = options?.maxTokens ?? 500;
  let diagnosis: ResponseDiagnosis = {
    class: "H_malformed",
    choicesCount: null,
    choiceKeys: [],
    messageKeys: [],
    role: undefined,
    contentState: "absent",
    finishReason: undefined,
    refusalPresent: false,
    toolCallsPresent: false,
    toolCallsCount: null,
    reasoningPresent: false,
    requestId: null,
  };
  while (true) {
    const { data, requestId } = await postCompletion(config, messages, {
      budget,
      temperature: options?.temperature,
      signal: options?.signal,
      responseFormat: options?.responseFormat,
    });
    diagnosis = diagnoseResponse(data);
    diagnosis.requestId = requestId;
    const content =
      diagnosis.contentState === "present"
        ? (
            data as {
              choices: Array<{ message: { content: string } }>;
            }
          ).choices[0].message.content
        : undefined;
    if (content) return content;
    // Budget starvation (reasoning models, or a long generation cut off at
    // the cap): give the model room to finish, up to the retry ceiling.
    // Every other empty shape (refusal, malformed, genuine empty) is final.
    if (isBudgetStarvation(diagnosis) && budget < MAX_RETRY_BUDGET) {
      budget = Math.min(MAX_RETRY_BUDGET, budget * 2);
      continue;
    }
    throw new ModelError("empty", "Model API returned no content", undefined, diagnosis);
  }
}
