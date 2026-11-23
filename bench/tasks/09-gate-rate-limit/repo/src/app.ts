import { loadConfig } from "./config";
import { Pipeline } from "./pipeline";
import { auth } from "./middleware/auth";
import { handleRoutes } from "./routes";

export interface AppOptions {
  auth?: { token?: string };
  rateLimit?: { limit?: number; windowMs?: number };
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
}

export function createApp(options: AppOptions = {}): Pipeline {
  const config = loadConfig();
  const token = options.auth?.token ?? config.auth.token;

  const app = new Pipeline(handleRoutes);
  app.use(auth({ token }));
  return app;
}
