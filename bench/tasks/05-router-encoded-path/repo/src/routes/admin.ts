import type { Router } from "../router";

export function registerAdminRoutes(router: Router): void {
  router.get("/admin/stats", () => Response.json({ admin: true, routes: "ok" }));
}
