import type { Router } from "../router";

const orders = [
  { id: "o_1", total: 42 },
  { id: "o_2", total: 7 },
];

export function registerOrderRoutes(router: Router): void {
  router.get("/api/orders", () => ({ status: 200, body: orders }));
  router.get("/api/orders/:id", ({ params }) => {
    const order = orders.find((candidate) => candidate.id === params.id);
    return order ? { status: 200, body: order } : { status: 404, body: { error: "not_found" } };
  });
  router.post("/api/orders", () => ({ status: 201, body: { created: true } }));
}
