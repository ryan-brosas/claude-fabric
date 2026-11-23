import { countRequest } from "../metrics/registry";
import { knownUsers, profileFor } from "../services/users";
import { search } from "../services/search";
import { sessionFor } from "../services/sessions";

export function handle(path: string): unknown {
  countRequest();
  if (path.startsWith("/users/")) return profileFor(path.slice("/users/".length));
  if (path === "/users") return knownUsers();
  if (path.startsWith("/search")) return search(path.slice(8) || "kettle", 1);
  if (path.startsWith("/sessions/")) return sessionFor(path.slice("/sessions/".length));
  return { error: "not_found" };
}
