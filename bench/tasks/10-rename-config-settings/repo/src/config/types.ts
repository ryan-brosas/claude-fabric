export interface Config {
  http: {
    port: number;
    host: string;
  };
  db: {
    url: string;
    poolSize: number;
  };
  features: {
    beta: boolean;
    auditLog: boolean;
  };
}

export type ConfigSource = "defaults" | "file" | "env";
