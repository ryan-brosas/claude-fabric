export function normalize(path: string): string {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  return "/" + parts.join("/");
}

export function paramOf(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length) || undefined;
}
