export class BusError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BusError";
    this.code = code;
  }
}

export function assertTopic(topic: string): void {
  if (typeof topic !== "string" || topic.length === 0) {
    throw new BusError("empty_topic", "topic must be a non-empty string");
  }
}
