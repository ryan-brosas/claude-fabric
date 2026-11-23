import type { HttpClient } from "../http/client";

export interface User {
  id: string;
  name: string;
}

export function createUserApi(client: HttpClient) {
  return {
    list: (): Promise<User[]> => client.getJson<User[]>("/users"),
    get: (id: string): Promise<User> => client.getJson<User>(`/users/${encodeURIComponent(id)}`),
  };
}
