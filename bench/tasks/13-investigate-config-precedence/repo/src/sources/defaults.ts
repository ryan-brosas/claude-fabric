export const defaults = {
  http: { host: "127.0.0.1", port: 3000, timeout: 30 },
  db: { url: "postgres://localhost/app", pool: 5 },
  features: { beta: false, flags: ["core"] },
};
