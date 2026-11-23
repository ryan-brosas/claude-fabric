import { join } from "node:path";

export function benchmarkPaths(root: string, temp: string, env: { BENCH_RUNS?: string; BENCH_RESULTS?: string }) {
  return {
    runs: env.BENCH_RUNS ?? join(temp, "fabric-bench-runs"),
    results: env.BENCH_RESULTS ?? join(root, "notes/bench/results.jsonl"),
  };
}
