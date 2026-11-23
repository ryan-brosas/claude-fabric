import { json } from "../http";
import type { Middleware } from "../pipeline";

export interface AuthOptions {
  token: string;
}

export function auth(options: AuthOptions): Middleware {
  return (request) => {
    const header = request.headers.authorization;
    if (header !== `Bearer ${options.token}`) {
      return json(401, { error: "unauthorized" });
    }
    return null;
  };
}
