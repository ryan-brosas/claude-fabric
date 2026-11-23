import type { Json } from "../resolve/merge";

export function cliValues(argv: string[] = []): Json {
  const http: Json = {};
  for (const arg of argv) {
    if (arg.startsWith("--port=")) http.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--host=")) http.host = arg.slice("--host=".length);
  }
  return Object.keys(http).length > 0 ? { http } : {};
}
