import type { GateRequest, GateResponse } from "./http";

export type Middleware = (request: GateRequest) => GateResponse | null;

export class Pipeline {
  #middleware: Middleware[] = [];
  #handler: (request: GateRequest) => GateResponse;

  constructor(handler: (request: GateRequest) => GateResponse) {
    this.#handler = handler;
  }

  use(middleware: Middleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  get size(): number {
    return this.#middleware.length;
  }

  handle(request: GateRequest): GateResponse {
    for (const middleware of this.#middleware) {
      const response = middleware(request);
      if (response) return response;
    }
    return this.#handler(request);
  }
}
