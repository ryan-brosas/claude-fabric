import { createBus } from "./bus";
import { logSink } from "./adapters/log-sink";

const bus = createBus({ onError: (error) => console.error("handler failed", error) });

bus.on("job.#", logSink({ write: (line) => console.log(line) }));

await bus.emit("job.retry.started", { attempt: 1 });
console.log(bus.snapshot());
