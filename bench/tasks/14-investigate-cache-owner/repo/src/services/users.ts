import { memoize } from "../cache/remember";
import type { UserProfile } from "../types";

const profiles = new Map<string, UserProfile>([
  ["u_1", { id: "u_1", plan: "pro", region: "eu" }],
  ["u_2", { id: "u_2", plan: "free", region: "us" }],
]);

export function profileFor(userId: string): UserProfile {
  return memoize(`user:${userId}:profile`, () => {
    const profile = profiles.get(userId);
    if (!profile) throw new Error(`unknown user ${userId}`);
    return profile;
  });
}

export function knownUsers(): string[] {
  return [...profiles.keys()];
}
