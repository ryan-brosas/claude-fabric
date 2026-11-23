import { apiBaseUrl } from "../config";
import { fetchJson } from "../http/fetch-json";
import type { Fetcher } from "../http/types";

export interface Order {
  id: string;
  total: number;
}

export interface ListOrdersOptions {
  token?: string;
  fetch?: Fetcher;
}

export async function listOrders(options: ListOrdersOptions = {}): Promise<Order[]> {
  const headers: Record<string, string> = options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};
  return fetchJson<Order[]>(`${apiBaseUrl()}/orders`, { headers, fetch: options.fetch });
}
