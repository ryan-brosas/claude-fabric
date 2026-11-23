import type { Handler } from "../router";

export function notFound(body: unknown = { error: "not_found" }): Handler {
  return () => ({ status: 404, body });
}
