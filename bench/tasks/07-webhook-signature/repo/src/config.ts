export interface Config {
  secret: string;
  toleranceSeconds: number;
  queuePath: string;
}

export const defaultConfig: Config = {
  secret: "dev-secret",
  toleranceSeconds: 300,
  queuePath: "./queue.jsonl",
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    secret: env.RELAY_SECRET ?? defaultConfig.secret,
    toleranceSeconds: Number(env.RELAY_TOLERANCE_SECONDS ?? defaultConfig.toleranceSeconds),
    queuePath: env.RELAY_QUEUE_FILE ?? defaultConfig.queuePath,
  };
}
