import type { EmitResult } from "../emitter";

export interface MetricsSnapshot {
  emitted: number;
  delivered: number;
  failed: number;
  byTopic: Record<string, number>;
}

export class BusMetrics {
  #emitted = 0;
  #delivered = 0;
  #failed = 0;
  #byTopic: Record<string, number> = {};

  record(result: EmitResult): void {
    this.#emitted += 1;
    this.#delivered += result.delivered;
    this.#failed += result.failed;
    this.#byTopic[result.topic] = (this.#byTopic[result.topic] ?? 0) + 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      emitted: this.#emitted,
      delivered: this.#delivered,
      failed: this.#failed,
      byTopic: { ...this.#byTopic },
    };
  }
}
