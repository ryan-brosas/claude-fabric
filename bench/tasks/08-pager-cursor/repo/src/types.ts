export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface ListUsersInput {
  limit?: number;
  cursor?: string | null;
}

export interface UserListPage {
  items: User[];
}
