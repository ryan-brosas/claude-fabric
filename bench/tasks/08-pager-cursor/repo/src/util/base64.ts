export function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function decodeBase64Url(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (encodeBase64Url(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}
