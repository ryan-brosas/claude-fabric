import { describe, expect, test } from "bun:test";
import { MemoryUserRepository } from "../src/repo/memory";
import { seedUsers } from "../src/repo/seed";
import { DEFAULT_LIMIT, InvalidLimitError, listUsers } from "../src/service/list-users";
import { handleListUsers } from "../src/http/handlers";

const repo = () => new MemoryUserRepository(seedUsers(25));

describe("listUsers", () => {
  test("uses the default page size", () => {
    const page = listUsers(repo());
    expect(page.items).toHaveLength(DEFAULT_LIMIT);
  });

  test("orders by createdAt then id", () => {
    const page = listUsers(repo(), { limit: 3 });
    expect(page.items.map((user) => user.id)).toEqual(["u_01", "u_02", "u_03"]);
  });

  test("rejects a limit outside 1..100", () => {
    expect(() => listUsers(repo(), { limit: 0 })).toThrow(InvalidLimitError);
    expect(() => listUsers(repo(), { limit: 101 })).toThrow(InvalidLimitError);
    expect(() => listUsers(repo(), { limit: 2.5 })).toThrow(InvalidLimitError);
  });
});

describe("handleListUsers", () => {
  test("answers 200 with a page", () => {
    const result = handleListUsers(repo(), { limit: "2" });
    expect(result.status).toBe(200);
    expect((result.body as { items: unknown[] }).items).toHaveLength(2);
  });

  test("answers 400 for a bad limit", () => {
    const result = handleListUsers(repo(), { limit: "0" });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_limit" });
  });
});
