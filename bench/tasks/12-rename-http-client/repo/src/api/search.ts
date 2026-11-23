import type { HttpClient } from "../http/client";

export interface SearchHit {
  id: string;
  score: number;
}

export function createSearchApi(client: HttpClient) {
  return {
    find: (query: string): Promise<SearchHit[]> =>
      client.getJson<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`),
  };
}
