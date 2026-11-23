import { describe, expect, test } from "bun:test";
import { HttpClient, createSearchApi, createUserApi, listOrders } from "../src/index";

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

describe("api factories", () => {
  test("users lists and gets", async () => {
    const fake = fakeFetch([{ id: "u1", name: "Ada" }]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch: fake.fetcher });
    const api = createUserApi(client);
    expect(await api.list()).toEqual([{ id: "u1", name: "Ada" }]);
    expect(fake.calls[0]?.url).toBe("https://api.test/users");
  });

  test("search encodes the query", async () => {
    const fake = fakeFetch([]);
    const client = new HttpClient({ baseUrl: "https://api.test", fetch: fake.fetcher });
    await createSearchApi(client).find("a b");
    expect(fake.calls[0]?.url).toBe("https://api.test/search?q=a%20b");
  });

  test("orders uses the configured base url", async () => {
    const fake = fakeFetch([{ id: "o1", total: 10 }]);
    const orders = await listOrders({ token: "t", fetch: fake.fetcher });
    expect(orders).toEqual([{ id: "o1", total: 10 }]);
    expect(fake.calls[0]?.url).toBe("https://api.example.test/orders");
    expect((fake.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer t");
  });
});
