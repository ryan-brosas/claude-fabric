export interface GateRequest {
  method: string;
  path: string;
  clientIp: string;
  headers: Record<string, string>;
}

export interface GateResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): GateResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}
