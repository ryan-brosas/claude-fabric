import { describe, expect, test } from "bun:test";
import { HttpClient, HttpError, fetchJson } from "../src/index";

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

describe("fetchJson", () => {
  test("parses JSON", async () => {
    const fake = fakeFetch({ ok: true });
    expect(await fetchJson("https://x.test/y", { fetch: fake.fetcher })).toEqual({ ok: true });
    expect(fake.calls[0]?.url).toBe("https://x.test/y");
  });

  test("throws HttpError with the payload", async () => {
    const fake = fakeFetch({ error: "nope" }, 500);
    let caught: unknown;
    try {
      await fetchJson("https://x.test/y", { fetch: fake.fetcher });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(500);
    expect((caught as HttpError).payload).toEqual({ error: "nope" });
  });
});

describe("HttpClient", () => {
  test("joins the base url and sends the token", async () => {
    const fake = fakeFetch([{ id: "u1" }]);
    const client = new HttpClient({ baseUrl: "https://api.test/", token: "t", fetch: fake.fetcher });
    expect(await client.getJson("/users")).toEqual([{ id: "u1" }]);
    expect(fake.calls[0]?.url).toBe("https://api.test/users");
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("posts JSON bodies", async () => {
    const fake = fakeFetch({ id: "u2" });
    const client = new HttpClient({ baseUrl: "https://api.test", fetch: fake.fetcher });
    expect(await client.postJson("/users", { name: "Ada" })).toEqual({ id: "u2" });
    expect(fake.calls[0]?.init?.body).toBe(JSON.stringify({ name: "Ada" }));
  });
});
