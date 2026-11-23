import { describe, expect, test } from "bun:test";
import { crossCheckDecision, proveDecision } from "gdp-wired";
import { decideResend, resendLaws, resendPolicy } from "./resend-policy.ts";

describe("Enter resend policy", () => {
  test("proves every law and refuses each broken variant", () => {
    for (const law of resendLaws(resendPolicy())) {
      const verdict = proveDecision(law);
      console.log(`Proof ${law.name}: ${JSON.stringify(verdict)}`);
      expect(verdict.proven && verdict.checked).toBe(true);
      const replay = crossCheckDecision(law);
      expect(replay.failure).toBeUndefined();
      expect(replay.checked).toBeGreaterThan(0);
    }
    for (const [bug, lawIndex] of [["no cap", 0], ["ignore pane", 1], ["stop early", 2]] as const) {
      const law = resendLaws(resendPolicy(bug))[lawIndex]!;
      const verdict = proveDecision(law);
      console.log(`Broken ${bug}: ${JSON.stringify(verdict)}`);
      expect(verdict.proven).toBe(false);
      expect(verdict.stuck).toBe("sat");
    }
  });
  test("compiled policy allows only pending resends 0 through 2", () => {
    for (let count = 0; count < 5; count++) {
      expect(decideResend({ count, pending: true }).resend).toBe(count < 3);
      expect(decideResend({ count, pending: false }).resend).toBe(false);
    }
  });
});
