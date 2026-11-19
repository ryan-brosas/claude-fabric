// The bridges the summary calls into copy pi-fabric's verified modules. The
// laws are proved in proofs/; these cases check the wiring around them.
import { describe, expect, test } from "bun:test";
import { allocateSummaryCarry, foldFailureLedger } from "../../src/compaction/verified/context.ts";
import { acceptSampleAccounting } from "../../src/compaction/verified/policy.ts";

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
