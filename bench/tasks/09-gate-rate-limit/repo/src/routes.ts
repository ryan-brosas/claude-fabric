import { json, type GateRequest, type GateResponse } from "./http";

export function handleRoutes(request: GateRequest): GateResponse {
  if (request.method === "GET" && request.path === "/hello") {
    return json(200, { hello: "world" });
  }
  if (request.path === "/echo") {
    return json(200, { echo: true });
  }
  return json(404, { error: "not_found" });
}
