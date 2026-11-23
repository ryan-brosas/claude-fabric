export function withAuth(
  headers: Record<string, string>,
  token?: string,
): Record<string, string> {
  const merged: Record<string, string> = { "content-type": "application/json", ...headers };
  if (token) merged.authorization = `Bearer ${token}`;
  return merged;
}
