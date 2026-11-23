import type { Router } from "../router";

export function registerHealthRoutes(router: Router): void {
  router.get("/health", () => ({ status: 200, body: { ok: true } }));
}
