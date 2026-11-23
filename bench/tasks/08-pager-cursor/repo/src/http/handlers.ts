import type { MemoryUserRepository } from "../repo/memory";
import { InvalidCursorError, InvalidLimitError, listUsers } from "../service/list-users";
import { serializePage } from "./serialize";

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface ListQuery {
  limit?: string;
  cursor?: string;
}

export function handleListUsers(repo: MemoryUserRepository, query: ListQuery = {}): HandlerResult {
  try {
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    const page = listUsers(repo, { limit });
    return { status: 200, body: serializePage(page) };
  } catch (error) {
    if (error instanceof InvalidLimitError) {
      return { status: 400, body: { error: "invalid_limit" } };
    }
    if (error instanceof InvalidCursorError) {
      return { status: 400, body: { error: "invalid_cursor" } };
    }
    throw error;
  }
}
