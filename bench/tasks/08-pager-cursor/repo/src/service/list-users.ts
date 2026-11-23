import type { MemoryUserRepository } from "../repo/memory";
import type { ListUsersInput, UserListPage } from "../types";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export class InvalidLimitError extends Error {
  readonly code = "invalid_limit";

  constructor(message: string) {
    super(message);
    this.name = "InvalidLimitError";
  }
}

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function listUsers(repo: MemoryUserRepository, input: ListUsersInput = {}): UserListPage {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidLimitError(`limit must be a whole number between 1 and ${MAX_LIMIT}`);
  }

  const ordered = repo.ordered();
  return { items: ordered.slice(0, limit) };
}
