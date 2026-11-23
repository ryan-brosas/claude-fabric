import { HttpError } from "./errors";
import type { Fetcher } from "./types";

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  fetch?: Fetcher;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const doFetch: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await doFetch(url, { headers: options.headers });
  const data: unknown = await response.json();
  if (!response.ok) throw new HttpError(response.status, data);
  return data as T;
}
