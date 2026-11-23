import type { Router } from "../router";
import { registerCartRoutes } from "./cart";
import { registerCatalogRoutes } from "./catalog";
import { registerHealthRoutes } from "./health";
import { registerOrderRoutes } from "./orders";

export function registerRoutes(router: Router): void {
  registerHealthRoutes(router);
  registerCatalogRoutes(router);
  registerOrderRoutes(router);
  registerCartRoutes(router);
}
