import { decideResend, type resendPolicy } from "./resend-policy.ts";

// Both fragments are required; no other continue or trust dialog is consent to billing.
export function billingNoticeVisible(pane: string): boolean {
  return pane.includes("We're changing auto mode to no longer charge for classifier requests")
    && pane.split(/\r?\n/).some((line) => line.trim() === "Enter to continue \u00b7 Esc to cancel");
}

export function trustDialogVisible(pane: string): boolean {
  return pane.includes("Is this a project you created or one you trust?");
}

// Reuse the compiled resend decision. Here pending means a newly observed billing notice.
export const billingNoticeLaws = (policy: ReturnType<typeof resendPolicy>) => [
  policy.law("billing notice: at most three continues", () => [],
    (out, input) => out.resend.eq(1).implies(input.count.lt(3))),
  policy.law("billing notice: continue only for a newly observed notice", () => [],
    (out, input) => out.resend.eq(1).implies(input.pending)),
  policy.law("billing notice: continue an eligible notice below the cap", () => [],
    (out, input) => input.pending.and(input.count.lt(3)).implies(out.resend.eq(1))),
];

// One Enter per appearance, including if the same capture is observed repeatedly.
export function createBillingNoticeHandler(send: () => Promise<void>) {
  let visible = false;
  let count = 0;
  return {
    get count() { return count; },
    async handle(pane: string) {
      const showing = billingNoticeVisible(pane);
      if (!showing) visible = false;
      if (!decideResend({ count, pending: showing && !visible }).resend) return;
      await send();
      count++;
      visible = true;
    },
  };
}

// True only when the submitted prompt is still in the idle input box, not in conversation history.
export function promptStillInInput(pane: string, prompt: string): boolean {
  const lines = pane.split(/\r?\n/);
  if (/esc to interrupt/i.test(pane)) return false;
  const input = lines.findLastIndex((line) => /^\s*❯/.test(line));
  if (input < 0) return false;
  const opening = prompt.trim().slice(0, 24);
  if (!opening || !lines[input]!.replace(/^\s*❯\s*/, "").startsWith(opening)) return false;
  const rule = /^\s*─{3,}\s*$/;
  if (!lines.slice(0, input).some((line) => rule.test(line))) return false;
  const bottomRule = lines.findIndex((line, i) => i > input && rule.test(line));
  if (bottomRule < 0) return false;
  return /auto mode|bypass|accept edits|for shortcuts|plan mode/i.test(lines.slice(bottomRule + 1).join("\n"));
}
