export interface QueueEntry {
  topic: string;
  payload: unknown;
  receivedAt: string;
}

export class Queue {
  #entries: QueueEntry[] = [];

  push(entry: QueueEntry): void {
    this.#entries.push(entry);
  }

  get size(): number {
    return this.#entries.length;
  }

  all(): QueueEntry[] {
    return [...this.#entries];
  }
}
