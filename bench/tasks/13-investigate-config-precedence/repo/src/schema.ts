export type Kind = "string" | "number" | "boolean" | "list";

export interface KeySpec {
  path: string;
  kind: Kind;
}

export const schema: KeySpec[] = [
  { path: "http.host", kind: "string" },
  { path: "http.port", kind: "number" },
  { path: "http.timeout", kind: "number" },
  { path: "db.url", kind: "string" },
  { path: "db.pool", kind: "number" },
  { path: "features.beta", kind: "boolean" },
  { path: "features.flags", kind: "list" },
];

export function coerce(kind: Kind, value: unknown): unknown {
  switch (kind) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      return value === true || value === "1" || value === "true";
    case "list":
      return Array.isArray(value) ? value : [value];
    default:
      return value;
  }
}
