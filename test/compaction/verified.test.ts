// The bridges the summary calls into copy pi-fabric's verified modules. The
// laws are proved in proofs/; these cases check the wiring around them.
import { describe, expect, test } from "bun:test";
import { allocateProtectedRoom } from "../../src/compaction/bounds.ts";
import { allocateSummaryCarry, foldFailureLedger } from "../../src/compaction/verified/context.ts";
import { acceptSampleAccounting } from "../../src/compaction/verified/policy.ts";
import { noCutVerdict } from "../../src/compaction/verified/no-cut.ts";
import { acceptRestorePosition } from "../../src/compaction/verified/restore-order.ts";

describe("verified restored ordering", () => {
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
