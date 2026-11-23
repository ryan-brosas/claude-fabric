import { HttpError } from "./errors";
import { withAuth } from "./headers";
import type { Fetcher, HttpResult } from "./types";

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  headers?: Record<string, string>;
  fetch?: Fetcher;
}

export class HttpClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: Fetcher;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: withAuth(this.#headers, this.#token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as T;
    if (!response.ok) throw new HttpError(response.status, data);
    return { status: response.status, headers: response.headers, data };
  }

  async getJson<T>(path: string): Promise<T> {
    const result = await this.request<T>("GET", path);
    return result.data;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const result = await this.request<T>("POST", path, body);
    return result.data;
  }
}
