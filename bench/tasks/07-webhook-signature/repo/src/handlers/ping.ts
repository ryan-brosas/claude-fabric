export interface PingPayload {
  id: string;
  at: string;
}

export function handlePing(payload: unknown): { ok: boolean } {
  if (typeof payload !== "object" || payload === null) return { ok: false };
  const record = payload as Partial<PingPayload>;
  return { ok: typeof record.id === "string" };
}
