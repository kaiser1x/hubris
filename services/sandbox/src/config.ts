export interface SandboxConfig {
  baseUrl: string;
  apiKey: string;
  projectId: string;
}

export function sandboxConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SandboxConfig | null {
  const apiKey = env.NEBIUS_API_KEY;
  const projectId = env.NEBIUS_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return {
    baseUrl: env.NEBIUS_SANDBOX_URL || "https://api.tokenfactory.nebius.com/sandboxes",
    apiKey,
    projectId,
  };
}

export function sandboxHeaders(config: SandboxConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    Project: config.projectId,
  };
}

export function sandboxUrl(config: SandboxConfig, path: string): string {
  return `${config.baseUrl.replace(/\/$/, "")}/v1${path}`;
}
