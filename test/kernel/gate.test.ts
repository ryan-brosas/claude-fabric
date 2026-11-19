// The gate every worker message passes is the compiled machine from proofs/gate.ts. The laws are
// proved there and its broken variants are refused by proof:check; these cases check the wiring
// around it: the host's verdict is the machine's, and a message the machine refuses is acted on by
// neither the tool calls nor the done.
import { describe, expect, test } from "bun:test";
import { MessageGate } from "../../src/kernel/verified/gate.ts";

describe("the verified message gate", () => {
  test("acts on a trusted tool call and stays open for the next one", () => {
    const gate = new MessageGate();
    expect(gate.decide(true, false)).toBe("call");
    expect(gate.decide(true, false)).toBe("call");
  });

  test("takes a trusted done, and only one", () => {
    const gate = new MessageGate();
    expect(gate.decide(true, true)).toBe("done");
    expect(gate.decide(true, true)).toBe("rejected");
  });

  test("acts on no tool call after the done", () => {
    const gate = new MessageGate();
    expect(gate.decide(true, true)).toBe("done");
    expect(gate.decide(true, false)).toBe("rejected");
  });

  test("refuses a message without the run's token, whatever its kind", () => {
    expect(new MessageGate().decide(false, false)).toBe("rejected");
    expect(new MessageGate().decide(false, true)).toBe("rejected");
  });

  test("a refused gate stays refused", () => {
    const gate = new MessageGate();
    expect(gate.decide(false, true)).toBe("rejected");
    expect(gate.decide(true, false)).toBe("rejected");
    expect(gate.decide(true, true)).toBe("rejected");
  });
});
