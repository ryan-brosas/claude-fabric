export class PathError extends Error {
  readonly code: "traversal" | "invalid_encoding";

  constructor(code: "traversal" | "invalid_encoding", message: string) {
    super(message);
    this.name = "PathError";
    this.code = code;
  }
}

export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function normalizePath(pathname: string): string {
  const rawPath = pathname.split("?")[0] ?? "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new PathError("invalid_encoding", `path is not valid percent encoding: ${rawPath}`);
  }

  const segments = splitPath(decoded);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new PathError("traversal", `path segment "${segment}" is not allowed`);
    }
    if (segment.includes("\u0000")) {
      throw new PathError("traversal", "path contains a null byte");
    }
  }

  return "/" + segments.join("/");
}
