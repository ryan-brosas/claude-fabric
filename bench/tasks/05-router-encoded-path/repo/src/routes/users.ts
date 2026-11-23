import type { Router } from "../router";

const users = [
  { id: "42", name: "Ada" },
  { id: "43", name: "Grace" },
];

export function registerUserRoutes(router: Router): void {
  router.get("/users", () => Response.json(users));
  router.get("/users/:id", ({ params }) => {
    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(user);
  });
}
