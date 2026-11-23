import type { User } from "../types";

const NAMES = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Ken", "Margaret", "Dennis"];

export function seedUsers(count = 25): User[] {
  return Array.from({ length: count }, (_, index) => {
    const name = NAMES[index % NAMES.length] ?? "User";
    return {
      id: `u_${String(index + 1).padStart(2, "0")}`,
      email: `${name.toLowerCase()}${index + 1}@example.com`,
      name: `${name} ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    };
  });
}
