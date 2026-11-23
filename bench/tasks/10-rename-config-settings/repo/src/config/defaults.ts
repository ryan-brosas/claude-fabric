import type { Config } from "./types";

export const defaultConfig: Config = {
  http: { port: 3000, host: "127.0.0.1" },
  db: { url: "postgres://localhost/app", poolSize: 5 },
  features: { beta: false, auditLog: false },
};
