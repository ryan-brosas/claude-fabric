import type { Router } from "../router";

export function registerCartRoutes(router: Router): void {
  router.get("/api/cart", () => ({ status: 200, body: { items: [] } }));
}
