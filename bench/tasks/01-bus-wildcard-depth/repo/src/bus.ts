import { Emitter, type EmitResult, type EmitterOptions } from "./emitter";
import { BusMetrics, type MetricsSnapshot } from "./adapters/metrics";

export class Bus extends Emitter {
  readonly metrics = new BusMetrics();

  constructor(options: EmitterOptions = {}) {
    super(options);
  }

  override async emit(topic: string, payload?: unknown): Promise<EmitResult> {
    const result = await super.emit(topic, payload);
    this.metrics.record(result);
    return result;
  }

  snapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }
}

export function createBus(options: EmitterOptions = {}): Bus {
  return new Bus(options);
}
