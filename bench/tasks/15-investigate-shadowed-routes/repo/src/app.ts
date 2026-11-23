import { legacyRedirect } from "./middleware/legacyRedirect";
import { notFound } from "./middleware/notFound";
import { Router } from "./router";
import { registerCartRoutes } from "./routes/cart";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerHealthRoutes } from "./routes/health";
import { registerOrderRoutes } from "./routes/orders";

export function createApp(): Router {
  const router = new Router();

  router.get("/legacy/*", legacyRedirect());
  registerHealthRoutes(router);
  registerCatalogRoutes(router);

  // Keep unknown API paths away from the HTML handler.
  router.get("/api/*", notFound({ error: "api_not_found" }));

  registerOrderRoutes(router);
  registerCartRoutes(router);

  return router;
}
