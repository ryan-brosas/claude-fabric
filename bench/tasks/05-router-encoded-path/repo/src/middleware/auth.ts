import { config } from "../config";
import type { Middleware } from "./chain";

export interface AuthOptions {
  token?: string;
}

export function authGuard(options: AuthOptions = {}): Middleware {
  const token = options.token ?? config.adminToken;
  return async (context, next) => {
    if (!context.path.startsWith("/admin")) return await next();
    const header = context.request.headers.get("x-admin-token");
    if (header !== token) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return await next();
  };
}
