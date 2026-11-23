import { describe, expect, test } from "bun:test";
import { billingNoticeVisible, promptStillInInput } from "./pane.ts";

const prompt = "I need to know what a staging deploy will actually listen on before we cut the release.";
const unsent = `Earlier text
────────────────────────────────────────────────────────────────────────────
❯ I need to know what a staging deploy will actually listen on before we cut the release.
────────────────────────────────────────────────────────────────────────────
  auto mode on (shift+tab to cycle)`;
const running = `❯ I need to know what a staging deploy will actually listen on before we cut the release.

  Reading files…
────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────
  esc to interrupt`;

const billingNotice = `  We're changing auto mode to no longer charge for classifier requests in Claude Code.
  However, this session isn't eligible because your requests go through inference.coralbricks.ai, which isn't compatible with this update.
  Auto mode works for now, and its classifier requests are billed as before. An upcoming release removes this fallback. ...
  To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing
  Enter to continue \u00b7 Esc to cancel`;

describe("billingNoticeVisible", () => {
  test("detects the full classifier billing notice", () => {
    expect(billingNoticeVisible(billingNotice)).toBe(true);
    expect(billingNoticeVisible(billingNotice.replace(/\n/g, "\r\n"))).toBe(true);
  });
  test("requires both the notice sentence and its exact continue line", () => {
    expect(billingNoticeVisible(billingNotice.replace("We're changing", "We are changing"))).toBe(false);
    expect(billingNoticeVisible(billingNotice.replace("Enter to continue \u00b7 Esc to cancel", "Enter to continue"))).toBe(false);
    expect(billingNoticeVisible("Another notice\nEnter to continue \u00b7 Esc to cancel")).toBe(false);
    expect(billingNoticeVisible(billingNotice.replace("Enter to continue \u00b7 Esc to cancel", "Not Enter to continue \u00b7 Esc to cancel"))).toBe(false);
  });
  test("rejects trust, theme, permission, running and idle panes", () => {
    const panes = [
      "Quick safety check: Is this a project you created or one you trust?\nEnter to confirm \u00b7 Esc to cancel",
      "Choose the text style that looks best with your terminal\nEnter to continue \u00b7 Esc to cancel",
      "Allow Bash to run this command?\nEnter to confirm \u00b7 Esc to cancel",
      running,
      unsent,
      "────────────────────\n❯\n────────────────────\n  auto mode on",
    ];
    for (const pane of panes) expect(billingNoticeVisible(pane)).toBe(false);
  });
});

describe("promptStillInInput", () => {
  test("detects the unsent prompt between input rules with the idle footer", () => {
    expect(promptStillInInput(unsent, prompt)).toBe(true);
  });
  test("does not resend when the turn is running and input is empty", () => {
    expect(promptStillInInput(running, prompt)).toBe(false);
  });
  test("never resends while an interrupt footer is visible, even with stale prompt text", () => {
    expect(promptStillInInput(unsent + " | esc to interrupt", prompt)).toBe(false);
  });
  test("does not mistake another prompt or a truncated pane for the pending prompt", () => {
    expect(promptStillInInput(unsent, "A different question with different opening words")).toBe(false);
    expect(promptStillInInput(unsent.replace("  auto mode on (shift+tab to cycle)", ""), prompt)).toBe(false);
    expect(promptStillInInput(unsent.replace(/─/g, ""), prompt)).toBe(false);
  });
});
