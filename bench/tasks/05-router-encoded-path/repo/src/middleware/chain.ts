import type { RouteContext } from "../router";

export type Middleware = (
  context: RouteContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export function chain(middleware: Middleware[], handler: (context: RouteContext) => Response | Promise<Response>) {
  return async (context: RouteContext): Promise<Response> => {
    let last = -1;
    const run = async (position: number): Promise<Response> => {
      if (position <= last) throw new Error("next() called twice");
      last = position;
      const current = middleware[position];
      if (!current) return await handler(context);
      return await current(context, () => run(position + 1));
    };
    return await run(0);
  };
}
