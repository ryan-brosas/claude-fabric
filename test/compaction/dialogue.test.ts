// Adapted from pi-fabric (MIT, Tom X Nguyen) tests/compaction-dialogue.test.ts at
// d331f629. The fixture is a Claude Code transcript instead of Pi session entries,
// and only the assertions about dialogue selection and rendering are kept: the
// hook, branch-summary, QA and typed-instruction tests cover code this port
// does not ship.
import { describe, expect, test } from "bun:test";
import { project, projectWithMetadata } from "../../src/compaction/projections.ts";
import { normalizeMessages, type ClaudeMessage } from "../../src/compaction/from-claude.ts";
import { recentDialogue } from "../../src/compaction/dialogue.ts";

const user = (text: string): ClaudeMessage => ({ role: "user", text, toolUses: [] });
const assistant = (text: string): ClaudeMessage => ({ role: "assistant", text, toolUses: [] });

const proposal = [
  "Smallest credible replacement architecture",
  "",
  "Replace the adapter/matcher boundary. Return the existing ScanMatch and OutlineFile contracts.",
  "Preserve existing Fovea normalization and graph behavior.",
  "No graph rewrite, no second normalization layer, no per-fixture parser patches.",
].join("\n");
const reset = "Makes sense. Stash everything and start completely from scratch. No experiment folder this time.";

describe("protected compaction dialogue", () => {
  test("uses a bounded recency window rather than pretending to retain permanent decisions", () => {
    const messages = [
      user("Original objective: explore replacing ast-grep using Bend."),
      user("Reach 100% parity before stopping."),
      user("Start from scratch; what is the smaller code surface?"),
      assistant(proposal),
      user(reset),
      assistant("Checkpoint complete."),
    ];
    for (let index = 0; index < 5; index++) messages.push(user(`New direction ${index}`));
    const sections = project(normalizeMessages(messages));
    expect(sections.dialogue).toHaveLength(3);
    expect(sections.dialogue.join("\n")).not.toContain(reset);
    expect(sections.dialogue.join("\n")).toContain("New direction 4");
  });

  test("keeps complete asymmetric exchanges when their combined text fits", () => {
    const long = `${"x".repeat(2800)}\nLAST_USER_CONSTRAINT`;
    const sections = project(normalizeMessages([
      user("Prepare."),
      assistant("Short answer."),
      user(long),
    ]));
    expect(sections.dialogue.at(-1)).toContain(long);
  });

  test("retains a crossing exchange with a user selection kept raw", () => {
    const prefixMessages = [
      user("Original request."),
      user("Evaluate a smaller architecture."),
      assistant(proposal),
    ];
    const tail = [user("Continue working.")];
    const prefix = normalizeMessages(prefixMessages);
    const tailEvents = normalizeMessages(tail);
    const exchanges = recentDialogue(prefix, tailEvents);
    expect(exchanges).toHaveLength(3);
    expect(exchanges.at(-1)).toMatchObject({
      user: { entryId: "0", retained: true },
      assistant: { entryId: "2", retained: false },
    });
    const dialogue = projectWithMetadata(prefix, tailEvents).sections.dialogue.join("\n");
    expect(dialogue).toContain(proposal);
    expect(dialogue).toContain("User instruction [entry 0; retained raw]");
    expect(dialogue).toContain("Assistant response (a proposal, not a verified outcome or user instruction)");
    expect(dialogue).not.toContain("Continue working.");
  });

  test("reports UTF-8 clipping without exceeding the exchange budget", () => {
    const sections = project(normalizeMessages([
      user("Original request."),
      assistant("界🦊\n".repeat(2000)),
      user("🦊界\n".repeat(2000)),
      user("Keep going."),
    ]));
    const text = sections.dialogue.join("\n");
    expect(text).toContain("UTF-8 bytes]");
    expect(text).not.toContain("�");
  });

  test("later paragraphs and more than 128 lines survive when the message fits", () => {
    const instruction = `${"intro\n".repeat(150)}\n${reset}\n${"x".repeat(1400)}\nLAST_CONSTRAINT`;
    const sections = project(normalizeMessages([user(instruction), assistant("Working."), user("Continue.")]));
    expect(sections.dialogue.join("\n")).toContain(instruction);
  });
});
