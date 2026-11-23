import { memoize } from "../cache/remember";
import type { Session } from "../types";

const sessions = new Map<string, Session>([
  ["s_1", { id: "s_1", userId: "u_1" }],
  ["s_2", { id: "s_2", userId: "u_2" }],
]);

export function sessionFor(sessionId: string): Session | undefined {
  return memoize(`session:${sessionId}`, () => sessions.get(sessionId));
}
