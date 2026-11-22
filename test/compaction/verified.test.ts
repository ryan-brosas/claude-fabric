// The bridges the summary calls into copy pi-fabric's verified modules. The
// laws are proved in proofs/; these cases check the wiring around them.
import { describe, expect, test } from "bun:test";
import { allocateProtectedRoom } from "../../src/compaction/bounds.ts";
import { allocateSummaryCarry, foldFailureLedger } from "../../src/compaction/verified/context.ts";
import { acceptSampleAccounting } from "../../src/compaction/verified/policy.ts";
import { noCutVerdict } from "../../src/compaction/verified/no-cut.ts";
import { acceptRestorePosition } from "../../src/compaction/verified/restore-order.ts";
import { acceptAddressedSample, acceptBoundedText, checkedProtectedShare, checkedProtectedTotal, checkedSamplePosition, checkedTextPlan, protectedItemBytes, sectionBytes } from "../../src/compaction/verified/bounds.ts";

describe("verified bounds machines", () => {
  test("refuses a wrong text length or marker count", () => {
    const facts = { source: 100, cap: 20, head: 5, tail: 5, marker: 10, omitted: 90,
      markerCount: 90, output: 20, unchanged: false, marked: true };
    expect(acceptBoundedText(facts)).toBe(true);
    expect(acceptBoundedText({ ...facts, output: 18 })).toBe(true);
    expect(acceptBoundedText({ ...facts, marker: 11 })).toBe(false);
    expect(acceptBoundedText({ ...facts, output: 21 })).toBe(false);
    expect(acceptBoundedText({ ...facts, markerCount: 89 })).toBe(false);
  });

  test("refuses wrong text-plan halves", () => {
    const facts = { source: 100, cap: 20, marker: 4, head: 5, tail: 5, produced: 20, half: 8, lower: 10 };
    expect(checkedTextPlan(facts)["out.other"]).toBe(8);
    expect(() => checkedTextPlan({ ...facts, half: 9 })).toThrow("byte plan failed");
  });

  test("refuses an incorrect protected share", () => {
    const facts = { cap: 21, header: 3, count: 3, quotient: 4, remainder: 0 };
    expect(checkedProtectedShare(facts)["out.room"]).toBe(12);
    expect(() => checkedProtectedShare({ ...facts, quotient: 5 })).toThrow("protected share failed");
  });

  test("refuses a protected total over room or demand", () => {
    const facts = { room: 10, used: 4, amount: 5, demand: 6 };
    expect(checkedProtectedTotal(facts)).toBe(9);
    expect(() => checkedProtectedTotal({ ...facts, amount: 7, demand: 7 })).toThrow("protected total failed");
    expect(() => checkedProtectedTotal({ ...facts, demand: 4 })).toThrow("protected total failed");
  });

  test("refuses a sample that keeps the wrong first or last counts", () => {
    const facts = { total: 6, limit: 3, earliest: 2, latest: 1, omitted: 3, lower: 1, upper: 2 };
    expect(acceptAddressedSample(facts)).toBe(true);
    expect(acceptAddressedSample({ ...facts, earliest: 1, omitted: 4 })).toBe(false);
    expect(acceptAddressedSample({ ...facts, latest: 0, omitted: 4 })).toBe(false);
  });

  test("refuses a sample position from outside the first or last half", () => {
    const facts = { total: 6, first: 2, last: 1, position: 2, actual: 5 };
    expect(checkedSamplePosition(facts)).toBe(true);
    expect(checkedSamplePosition({ ...facts, actual: 4 })).toBe(false);
    expect(checkedSamplePosition({ ...facts, position: 3 })).toBe(false);
  });

  test("section and protected-item machines refuse non-natural facts", () => {
    expect(sectionBytes(15, 10)).toBe(10);
    expect(() => sectionBytes(-1, 10)).toThrow(RangeError);
    const item = protectedItemBytes(9, 3, 3, 4);
    expect([item["out.initial"], item["out.budget"], item["out.remaining"]]).toEqual([3, 7, 0]);
    expect(() => protectedItemBytes(9, 3, -1, 4)).toThrow(RangeError);
  });
});

describe("verified restored ordering", () => {
  test("applies an admitted restoration position", () => {
    expect(acceptRestorePosition({ previous: 0, position: 1, expectedPosition: 1, expectedFirst: 1, actualFirst: 1,
      expectedLength: 2, actualLength: 2, matches: true })).toBe(true);
  });

  test("refuses a swapped position and an extra outcome in the suffix", () => {
    const facts = { previous: 2, position: 3, expectedPosition: 2, expectedFirst: 2, actualFirst: 3,
      expectedLength: 3, actualLength: 4, matches: true };
    expect(acceptRestorePosition(facts)).toBe(true);
    expect(acceptRestorePosition({ ...facts, position: 1 })).toBe(false);
    expect(acceptRestorePosition({ ...facts, actualLength: 5 })).toBe(false);
  });
});

describe("summary carry allocation", () => {
  test("reserves the framing, then the newest blocks, then the carry, then history", () => {
    expect(allocateSummaryCarry(1000, 100, 200, 250, 400))
      .toEqual({ footerBytes: 100, newestBytes: 200, carryBytes: 250, historyBytes: 400 });
  });

  test("splits the older room between the carry and history, history keeping half", () => {
    expect(allocateSummaryCarry(1000, 100, 200, 900, 400))
      .toEqual({ footerBytes: 100, newestBytes: 200, carryBytes: 350, historyBytes: 350 });
  });

  test("leaves the carry everything history does not ask for", () => {
    expect(allocateSummaryCarry(1000, 100, 200, 900, 20))
      .toEqual({ footerBytes: 100, newestBytes: 200, carryBytes: 680, historyBytes: 20 });
  });

  test("caps the newest blocks at the room the framing leaves", () => {
    expect(allocateSummaryCarry(1000, 900, 500, 50, 50))
      .toEqual({ footerBytes: 900, newestBytes: 100, carryBytes: 0, historyBytes: 0 });
  });

  test("never allocates more than the ceiling", () => {
    const cases: [number, number, number, number, number][] = [
      [32768, 190, 23552, 40000, 19456],
      [32768, 190, 5000, 33000, 19456],
      [0, 0, 0, 10, 10],
      [100, 1000, 1000, 1000, 1000],
    ];
    for (const [limit, footer, newest, earlier, history] of cases) {
      const allocation = allocateSummaryCarry(limit, footer, newest, earlier, history);
      const used = allocation.footerBytes + allocation.newestBytes + allocation.carryBytes + allocation.historyBytes;
      expect(used).toBeLessThanOrEqual(limit);
    }
  });

  test("refuses a demand that is not a safe natural", () => {
    expect(() => allocateSummaryCarry(-1, 0, 0, 0, 0)).toThrow();
    expect(() => allocateSummaryCarry(10, 0, 1.5, 0, 0)).toThrow();
  });
});

describe("protected summary room", () => {
  test("reserves framing, request and recent dialogue before giving users priority over old replies", () => {
    const roomy = allocateProtectedRoom(2000, 3072, 20000, 9000);
    expect(roomy).toEqual({ footerBytes: 6864, newestBytes: 20000, carryBytes: 5904, historyBytes: 0 });
    const full = allocateProtectedRoom(12288, 3072, 22528, 9000);
    expect(full).toEqual({ footerBytes: 17152, newestBytes: 15616, carryBytes: 0, historyBytes: 0 });
    const shortUser = allocateProtectedRoom(2000, 3072, 100, 9000);
    expect(shortUser.newestBytes).toBe(100);
    expect(shortUser.carryBytes).toBe(9000);
  });
});

describe("failure ledger", () => {
  test("itemizes open failures newest first, up to the limit, and counts the rest", () => {
    const failures = Array.from({ length: 30 }, () => ({ fresh: true, resolved: false }));
    const ledger = foldFailureLedger(failures, 24);
    expect(ledger).toMatchObject({ total: 30, open: 30, aged: 0, resolved: 0 });
    expect(ledger.itemized.filter(Boolean)).toHaveLength(24);
    expect(ledger.itemized.slice(0, 24).every(Boolean)).toBe(true);
    expect(ledger.itemized.slice(24).some(Boolean)).toBe(false);
  });

  test("never itemizes a resolved failure", () => {
    const ledger = foldFailureLedger([{ fresh: true, resolved: true }, { fresh: true, resolved: false }], 24);
    expect(ledger.itemized).toEqual([false, true]);
    expect(ledger.resolved).toBe(1);
  });
});

describe("sample accounting", () => {
  test("accepts exact accounting within the limit", () => {
    expect(acceptSampleAccounting(10, 8, 2, 8)).toBe(true);
  });

  test("refuses lost entries and an over-limit retain", () => {
    expect(acceptSampleAccounting(10, 8, 1, 8)).toBe(false);
    expect(acceptSampleAccounting(10, 9, 1, 8)).toBe(false);
    expect(acceptSampleAccounting(-1, 0, 0, 0)).toBe(false);
  });
});

describe("the verified no-cut verdict", () => {
  test("skips a transcript within the budget and sends one over it to core", () => {
    expect(noCutVerdict(0, 20_000)).toBe("skip");
    expect(noCutVerdict(20_000, 20_000)).toBe("skip");
    expect(noCutVerdict(20_001, 20_000)).toBe("core");
    expect(noCutVerdict(250_000, 20_000)).toBe("core");
  });
});
