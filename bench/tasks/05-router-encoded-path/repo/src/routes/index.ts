import { registerAdminRoutes } from "./admin";
import { registerFileRoutes } from "./files";
import { registerHealthRoutes } from "./health";
import { registerUserRoutes } from "./users";
import type { Router } from "../router";

export function registerRoutes(router: Router): void {
  registerHealthRoutes(router);
  registerUserRoutes(router);
  registerFileRoutes(router);
  registerAdminRoutes(router);
}
