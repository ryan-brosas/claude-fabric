export interface RouteResult {
  status: number;
  body: unknown;
}

export interface RouteInput {
  method: string;
  path: string;
  params: Record<string, string>;
}

export type Handler = (input: RouteInput) => RouteResult;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  const hasWildcard = pattern.at(-1) === "*";
  if (!hasWildcard && pattern.length !== actual.length) return null;
  if (hasWildcard && actual.length < pattern.length - 1) return null;

  const params: Record<string, string> = {};
  const fixed = hasWildcard ? pattern.length - 1 : pattern.length;
  for (let index = 0; index < fixed; index += 1) {
    const expected = pattern[index];
    const value = actual[index];
    if (expected === undefined) return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = value ?? "";
      continue;
    }
    if (expected !== value) return null;
  }
  return params;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const segments = pattern.split("/").filter((segment) => segment.length > 0);
    this.#routes.push({ method: method.toUpperCase(), pattern, segments, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  get size(): number {
    return this.#routes.length;
  }

  patterns(): string[] {
    return this.#routes.map((route) => `${route.method} ${route.pattern}`);
  }

  handle(method: string, path: string): RouteResult {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const wanted = method.toUpperCase();
    for (const route of this.#routes) {
      if (route.method !== wanted) continue;
      const params = matchSegments(route.segments, segments);
      if (params) return route.handler({ method: wanted, path, params });
    }
    return { status: 404, body: { error: "not_found" } };
  }
}
