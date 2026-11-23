const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function splitTopic(topic: string): string[] {
  if (topic.length === 0) throw new Error("topic must not be empty");
  const parts = topic.split(".");
  for (const part of parts) {
    if (part.length === 0) throw new Error(`empty segment in topic "${topic}"`);
  }
  return parts;
}

export function isPattern(topic: string): boolean {
  return topic.includes("*") || topic.includes("#");
}

export function validatePattern(pattern: string): void {
  const parts = splitTopic(pattern);
  parts.forEach((part, index) => {
    if (part === "#" && index !== parts.length - 1) {
      throw new Error(`"#" must be the last segment in "${pattern}"`);
    }
    if (part === "*" || part === "#") return;
    if (!SEGMENT.test(part)) {
      throw new Error(`bad segment "${part}" in "${pattern}"`);
    }
  });
}

/**
 * True when `topic` is covered by `pattern`.
 *
 * Patterns use `*` for one segment and `#` for the rest of the tree.
 */
export function matches(pattern: string, topic: string): boolean {
  const wanted = splitTopic(pattern);
  const actual = splitTopic(topic);
  if (wanted.length > actual.length + 1) return false;

  for (let index = 0; index < wanted.length; index += 1) {
    const segment = wanted[index];
    if (segment === "#") return true;
    if (segment === "*") {
      if (index === wanted.length - 1) return true;
      continue;
    }
    if (segment !== actual[index]) return false;
  }

  return actual.length === wanted.length;
}
