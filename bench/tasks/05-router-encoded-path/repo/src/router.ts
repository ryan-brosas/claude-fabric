import { matchSegments } from "./params";

export interface RouteContext {
  request: Request;
  params: Record<string, string>;
  path: string;
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
  handler: RouteHandler;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const segments = pattern.split("/").filter((segment) => segment.length > 0);
    this.#routes.push({ method: method.toUpperCase(), pattern, segments, handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  match(method: string, path: string): Match | null {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const wanted = method.toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== wanted) continue;
      const params = matchSegments(route.segments, segments);
      if (params) return { route, params, handler: route.handler };
    }
    return null;
  }

  get size(): number {
    return this.#routes.length;
  }
}
