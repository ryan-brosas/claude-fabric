export function apiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.FETCHKIT_BASE_URL ?? "https://api.example.test";
}
