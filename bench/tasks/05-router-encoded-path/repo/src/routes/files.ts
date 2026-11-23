import type { Router } from "../router";

export function registerFileRoutes(router: Router): void {
  router.get("/files/:name", ({ params }) => Response.json({ name: params.name }));
}
