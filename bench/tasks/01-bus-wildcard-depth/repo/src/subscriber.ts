import { matches, validatePattern } from "./topic";
import { nextId } from "./util/id";

export type Handler<T = unknown> = (
  payload: T,
  meta: { topic: string; pattern: string; subscription: string },
) => void | Promise<void>;

export interface Subscription {
  readonly id: string;
  readonly pattern: string;
  readonly priority: number;
  readonly once: boolean;
  readonly handler: Handler<never>;
}

export interface SubscribeOptions {
  priority?: number;
  once?: boolean;
}

export class Registry {
  #items: Subscription[] = [];

  add(pattern: string, handler: Handler<never>, options: SubscribeOptions = {}): string {
    validatePattern(pattern);
    const id = nextId("sub");
    this.#items.push({
      id,
      pattern,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      handler,
    });
    return id;
  }

  remove(id: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.id !== id);
    return this.#items.length !== before;
  }

  removePattern(pattern: string): number {
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.pattern !== pattern);
    return before - this.#items.length;
  }

  clear(): void {
    this.#items = [];
  }

  all(): readonly Subscription[] {
    return this.#items;
  }

  matching(topic: string): Subscription[] {
    return this.#items
      .filter((item) => matches(item.pattern, topic))
      .sort((left, right) => right.priority - left.priority);
  }
}
