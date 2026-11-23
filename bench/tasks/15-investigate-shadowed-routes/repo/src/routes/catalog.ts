import type { Router } from "../router";

const products = [
  { id: "p_1", name: "Blue kettle" },
  { id: "p_2", name: "Red kettle" },
];

export function registerCatalogRoutes(router: Router): void {
  router.get("/api/products", () => ({ status: 200, body: products }));
  router.get("/api/products/:id", ({ params }) => {
    const product = products.find((candidate) => candidate.id === params.id);
    return product ? { status: 200, body: product } : { status: 404, body: { error: "not_found" } };
  });
}
