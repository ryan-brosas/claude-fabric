import type { UserListPage } from "../types";

export interface SerializedPage {
  items: UserListPage["items"];
}

export function serializePage(page: UserListPage): SerializedPage {
  return { items: page.items };
}
