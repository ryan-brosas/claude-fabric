import { describe, expect, test } from "bun:test";
import { crossCheckDecision, proveDecision } from "gdp-wired";
import { billingNoticeLaws, createBillingNoticeHandler } from "./pane.ts";
import { resendPolicy } from "./resend-policy.ts";

const notice = "We're changing auto mode to no longer charge for classifier requests in Claude Code.\n" +
  "Enter to continue \u00b7 Esc to cancel";
const idle = "────────────────────\n❯\n────────────────────\n  auto mode on";

describe("billing notice cap", () => {
  test("proves each law and refuses its broken policy", () => {
    for (const law of billingNoticeLaws(resendPolicy())) {
      const verdict = proveDecision(law);
      console.log(`Proof ${law.name}: ${JSON.stringify(verdict)}`);
      expect(verdict.proven && verdict.checked).toBe(true);
      const replay = crossCheckDecision(law);
      expect(replay.failure).toBeUndefined();
      expect(replay.checked).toBeGreaterThan(0);
    }
    for (const [bug, lawIndex] of [["no cap", 0], ["ignore pane", 1], ["stop early", 2]] as const) {
      const law = billingNoticeLaws(resendPolicy(bug))[lawIndex]!;
      const verdict = proveDecision(law);
      console.log(`Broken ${bug} for ${law.name}: ${JSON.stringify(verdict)}`);
      expect(verdict.proven).toBe(false);
      expect(verdict.stuck).toBe("sat");
    }
  });

  test("sends once per appearance, caps the session at three and starts each session at zero", async () => {
    const keys: string[] = [];
    const handler = createBillingNoticeHandler(async () => { keys.push("Enter"); });
    await handler.handle(idle);
    expect(handler.count).toBe(0);
    for (let appearance = 0; appearance < 5; appearance++) {
      await handler.handle(notice);
      await handler.handle(notice);
      expect(handler.count).toBe(Math.min(appearance + 1, 3));
      await handler.handle(idle);
    }
    expect(keys).toEqual(["Enter", "Enter", "Enter"]);
    const next = createBillingNoticeHandler(async () => { keys.push("next Enter"); });
    expect(next.count).toBe(0);
    await next.handle(notice);
    expect(next.count).toBe(1);
    expect(keys).toEqual(["Enter", "Enter", "Enter", "next Enter"]);
  });

  test("does not count a rejected send and can retry while the notice remains", async () => {
    let attempts = 0;
    const handler = createBillingNoticeHandler(async () => {
      attempts++;
      if (attempts === 1) throw new Error("send failed");
    });
    await expect(handler.handle(notice)).rejects.toThrow("send failed");
    expect(handler.count).toBe(0);
    await handler.handle(notice);
    expect(handler.count).toBe(1);
    expect(attempts).toBe(2);
  });
});
