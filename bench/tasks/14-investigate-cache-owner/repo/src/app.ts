import { handle } from "./http/routes";
import { cleanupPlan } from "./jobs/cleanup";
import { lastRefresh, markRefreshed, trackedJobs } from "./jobs/refresh";

export interface App {
  handle(path: string): unknown;
  refresh(jobId: string, at: number): void;
  tracked(): number;
  cleanup(): ReturnType<typeof cleanupPlan>;
}

export function createApp(): App {
  return {
    handle,
    refresh: (jobId, at) => markRefreshed(jobId, at),
    tracked: () => trackedJobs(),
    cleanup: () => cleanupPlan(),
  };
}

export { lastRefresh };
