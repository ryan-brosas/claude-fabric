import { describe, expect, test } from "bun:test";
import {
  ApiClient,
  ApiError,
  createSearchApi,
  createUserApi,
  listOrders,
  requestJson,
} from "../../src/index";

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetcher };
}

describe("requestJson", () => {
  test("parses JSON", async () => {
    const fake = fakeFetch({ ok: true });
    expect(await requestJson("https://x.test/y", { fetch: fake.fetcher })).toEqual({ ok: true });
    expect(fake.calls[0]?.url).toBe("https://x.test/y");
  });

  test("throws ApiError with status and payload", async () => {
    const fake = fakeFetch({ error: "nope" }, 503);
    let caught: unknown;
    try {
      await requestJson("https://x.test/y", { fetch: fake.fetcher });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(503);
    expect((caught as ApiError).payload).toEqual({ error: "nope" });
  });
});

describe("ApiClient", () => {
  test("joins the base url, sends the token and posts JSON", async () => {
    const fake = fakeFetch({ id: "u2" });
    const client = new ApiClient({ baseUrl: "https://api.test/", token: "t", fetch: fake.fetcher });
    expect(await client.getJson("/users")).toEqual({ id: "u2" });
    expect(fake.calls[0]?.url).toBe("https://api.test/users");
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t");

    await client.postJson("/users", { name: "Ada" });
    expect(fake.calls[1]?.init?.body).toBe(JSON.stringify({ name: "Ada" }));
  });

  test("raises ApiError on a failure response", async () => {
    const fake = fakeFetch({ error: "denied" }, 403);
    const client = new ApiClient({ baseUrl: "https://api.test", fetch: fake.fetcher });
    await expect(client.getJson("/users")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("the api clients keep working", () => {
  test("users and search use the client", async () => {
    const fake = fakeFetch([{ id: "u1", name: "Ada" }]);
    const client = new ApiClient({ baseUrl: "https://api.test", fetch: fake.fetcher });
    expect(await createUserApi(client).list()).toEqual([{ id: "u1", name: "Ada" }]);
    await createSearchApi(client).find("a b");
    expect(fake.calls[1]?.url).toBe("https://api.test/search?q=a%20b");
  });

  test("orders uses the configured base url and token", async () => {
    const fake = fakeFetch([{ id: "o1", total: 10 }]);
    expect(await listOrders({ token: "t", fetch: fake.fetcher })).toEqual([{ id: "o1", total: 10 }]);
    expect(fake.calls[0]?.url).toBe("https://api.example.test/orders");
    expect((fake.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer t");
  });
});
