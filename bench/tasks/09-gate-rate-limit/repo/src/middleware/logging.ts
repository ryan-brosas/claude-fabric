import type { Middleware } from "../pipeline";

export interface LoggingOptions {
  sink?: (line: string) => void;
}

export function logging(options: LoggingOptions = {}): Middleware {
  const sink = options.sink ?? (() => {});
  return (request) => {
    sink(`${request.method} ${request.path} ${request.clientIp}`);
    return null;
  };
}
