import { assertTopic } from "./errors";
import { Registry, type Handler, type SubscribeOptions, type Subscription } from "./subscriber";

export interface EmitResult {
  topic: string;
  delivered: number;
  failed: number;
}

export interface EmitterOptions {
  onError?: (error: unknown, subscription: Subscription) => void;
}

export class Emitter {
  protected readonly registry = new Registry();
  #onError?: EmitterOptions["onError"];

  constructor(options: EmitterOptions = {}) {
    this.#onError = options.onError;
  }

  on(pattern: string, handler: Handler<never>, options: SubscribeOptions = {}): string {
    return this.registry.add(pattern, handler, options);
  }

  once(pattern: string, handler: Handler<never>, options: SubscribeOptions = {}): string {
    return this.registry.add(pattern, handler, { ...options, once: true });
  }

  off(id: string): boolean {
    return this.registry.remove(id);
  }

  offPattern(pattern: string): number {
    return this.registry.removePattern(pattern);
  }

  listeners(topic: string): string[] {
    return this.registry.matching(topic).map((item) => item.id);
  }

  clear(): void {
    this.registry.clear();
  }

  async emit(topic: string, payload?: unknown): Promise<EmitResult> {
    assertTopic(topic);
    const subscriptions = this.registry.matching(topic);
    let delivered = 0;
    let failed = 0;

    for (const subscription of subscriptions) {
      if (subscription.once) this.registry.remove(subscription.id);
      try {
        await subscription.handler(payload, {
          topic,
          pattern: subscription.pattern,
          subscription: subscription.id,
        });
        delivered += 1;
      } catch (error) {
        failed += 1;
        this.#onError?.(error, subscription);
      }
    }

    return { topic, delivered, failed };
  }
}
