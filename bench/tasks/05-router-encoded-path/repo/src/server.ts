import { HttpError } from "./errors";
import { chain, type Middleware } from "./middleware/chain";
import { authGuard, logging } from "./middleware/index";
import { normalizePath, PathError } from "./path";
import { registerRoutes } from "./routes/index";
import { Router } from "./router";
import { config } from "./config";

export interface HandlerOptions {
  router?: Router;
  middleware?: Middleware[];
}

export function createRouter(): Router {
  const router = new Router();
  registerRoutes(router);
  return router;
}

export function createHandler(options: HandlerOptions = {}) {
  const router = options.router ?? createRouter();
  const middleware = options.middleware ?? [logging(), authGuard({ token: config.adminToken })];

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let path: string;
    try {
      path = normalizePath(url.pathname);
    } catch (error) {
      if (error instanceof PathError) {
        return Response.json({ error: error.code }, { status: 400 });
      }
      throw error;
    }

    const match = router.match(request.method, path);
    if (!match) {
      return Response.json({ error: "not_found", path }, { status: 404 });
    }

    try {
      return await chain(middleware, match.handler)({ request, params: match.params, path });
    } catch (error) {
      if (error instanceof HttpError) {
        return Response.json({ error: error.code }, { status: error.status });
      }
      throw error;
    }
  };
}
