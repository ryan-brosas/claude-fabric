export interface Config {
  rateLimit: { limit: number; windowMs: number };
  auth: { token: string };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    rateLimit: {
      limit: Number(env.GATE_RATE_LIMIT ?? 3),
      windowMs: Number(env.GATE_RATE_WINDOW_MS ?? 60_000),
    },
    auth: { token: env.GATE_TOKEN ?? "dev-token" },
  };
}
