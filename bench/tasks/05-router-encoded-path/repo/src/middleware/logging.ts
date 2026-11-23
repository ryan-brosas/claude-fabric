import { config } from "../config";
import type { Middleware } from "./chain";

let counter = 0;

export function logging(): Middleware {
  return async (context, next) => {
    counter += 1;
    const response = await next();
    const headers = new Headers(response.headers);
    headers.set(config.requestIdHeader, `req_${counter}`);
    return new Response(response.body, { status: response.status, headers });
  };
}
