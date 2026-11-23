import { describe, expect, test } from "bun:test";
import { MemoryUserRepository } from "../../src/repo/memory";
import { seedUsers } from "../../src/repo/seed";
import {
  InvalidCursorError,
  InvalidLimitError,
  listUsers,
} from "../../src/service/list-users";
import { handleListUsers } from "../../src/http/handlers";
import type { User } from "../../src/types";

function users(count: number): User[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `u_${String(index + 1).padStart(2, "0")}`,
    email: `user${index + 1}@example.com`,
    name: `User ${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
}

function paged(repo: MemoryUserRepository, limit: number) {
  const pages: { ids: string[]; nextCursor: string | null }[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = listUsers(repo, { limit, cursor });
    pages.push({ ids: page.items.map((user) => user.id), nextCursor: page.nextCursor });
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("cursor pagination", () => {
  test("walks the whole collection without gaps or repeats", () => {
    const repo = new MemoryUserRepository(users(25));
    const pages = paged(repo, 10);
    expect(pages.map((page) => page.ids.length)).toEqual([10, 10, 5]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    expect(pages.every((page, index) => index === pages.length - 1 || typeof page.nextCursor === "string")).toBe(true);
    const ids = pages.flatMap((page) => page.ids);
    expect(ids).toEqual(repo.ordered().map((user) => user.id));
    expect(new Set(ids).size).toBe(25);
  });

  test("the default page size is 20", () => {
    const repo = new MemoryUserRepository(users(25));
    const first = listUsers(repo);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = listUsers(repo, { cursor: first.nextCursor });
    expect(second.items.map((user) => user.id)).toEqual(["u_21", "u_22", "u_23", "u_24", "u_25"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a full page followed by an empty tail ends with a null cursor", () => {
    const repo = new MemoryUserRepository(users(20));
    const page = listUsers(repo, { limit: 20 });
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeNull();
  });

  test("ties on createdAt are broken by id", () => {
    const createdAt = "2026-02-01T00:00:00.000Z";
    const repo = new MemoryUserRepository([
      { id: "b", email: ["b", "example.com"].join("@"), name: "B", createdAt },
      { id: "a", email: ["a", "example.com"].join("@"), name: "A", createdAt },
      { id: "c", email: ["c", "example.com"].join("@"), name: "C", createdAt },
    ]);
    const first = listUsers(repo, { limit: 1 });
    expect(first.items.map((user) => user.id)).toEqual(["a"]);
    const second = listUsers(repo, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((user) => user.id)).toEqual(["b", "c"]);
    expect(second.nextCursor).toBeNull();
  });

  test("limits are still validated", () => {
    const repo = new MemoryUserRepository(users(5));
    expect(() => listUsers(repo, { limit: 0 })).toThrow(InvalidLimitError);
    expect(() => listUsers(repo, { limit: 101 })).toThrow(InvalidLimitError);
    expect(() => listUsers(repo, { limit: 1.5 })).toThrow(InvalidLimitError);
  });

  test("a cursor this service did not make is rejected", () => {
    const repo = new MemoryUserRepository(users(5));
    expect(() => listUsers(repo, { cursor: "not-a-cursor" })).toThrow(InvalidCursorError);
    expect(() => listUsers(repo, { cursor: Buffer.from("{}").toString("base64url") })).toThrow(
      InvalidCursorError,
    );
  });
});

describe("HTTP layer", () => {
  test("pages through the handler", () => {
    const repo = new MemoryUserRepository(users(25));
    const first = handleListUsers(repo, { limit: "10" });
    expect(first.status).toBe(200);
    const body = first.body as { items: { id: string }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(10);
    expect(typeof body.nextCursor).toBe("string");

    const second = handleListUsers(repo, { limit: "10", cursor: body.nextCursor ?? "" });
    const secondBody = second.body as { items: { id: string }[]; nextCursor: string | null };
    expect(secondBody.items[0]?.id).toBe("u_11");
    expect(secondBody.nextCursor).not.toBeNull();
  });

  test("bad cursor and bad limit answer 400", () => {
    const repo = new MemoryUserRepository(users(5));
    expect(handleListUsers(repo, { cursor: "nope" }).status).toBe(400);
    expect(handleListUsers(repo, { cursor: "nope" }).body).toEqual({ error: "invalid_cursor" });
    expect(handleListUsers(repo, { limit: "0" }).body).toEqual({ error: "invalid_limit" });
  });
});
