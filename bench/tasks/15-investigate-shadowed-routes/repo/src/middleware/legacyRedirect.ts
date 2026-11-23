import type { Handler } from "../router";

export function legacyRedirect(): Handler {
  return () => ({ status: 301, body: { moved: true } });
}
