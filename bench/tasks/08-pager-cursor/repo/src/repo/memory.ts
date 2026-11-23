import type { User } from "../types";

export class MemoryUserRepository {
  #users: User[];

  constructor(users: User[]) {
    this.#users = [...users];
  }

  add(user: User): void {
    this.#users.push(user);
  }

  count(): number {
    return this.#users.length;
  }

  all(): User[] {
    return [...this.#users];
  }

  /** Stable order: createdAt ascending, then id ascending. */
  ordered(): User[] {
    return [...this.#users].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
  }
}
