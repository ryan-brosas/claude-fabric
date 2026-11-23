import type { Router } from "../router";

export function registerHealthRoutes(router: Router): void {
  router.get("/health", () => Response.json({ ok: true }));
}
