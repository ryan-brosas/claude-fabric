export interface HttpResult<T> {
  status: number;
  headers: Headers;
  data: T;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
