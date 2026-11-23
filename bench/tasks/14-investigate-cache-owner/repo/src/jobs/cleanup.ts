export interface CleanupPlan {
  tables: string[];
  olderThanDays: number;
}

export function cleanupPlan(now = new Date()): CleanupPlan {
  return {
    tables: ["sessions", "events"],
    olderThanDays: now.getUTCDate() % 2 === 0 ? 30 : 7,
  };
}
