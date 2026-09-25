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

export async function chatComplete(
  config: LlmConfig,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }
): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Model API error: ${response.status} ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model API returned no content");
  return content;
}
