// Read supplies byte lengths of actual numbered lines and prospective notices. The admission
// decision reserves the notice as well as the body; the page decision supplies the last line,
// next offset and whether a notice is needed. String encoding and assembly remain in Read.
import { fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type ReadContinuationBug =
  | "ignore notice bytes" | "ignore line limit" | "refuse a fitting line"
  | "skip the next line" | "misstate the last line" | "omit continuation notice"
  | "invent a notice" | "drop the admitted line's bytes" | "charge a refused line";

const admission = (bug?: ReadContinuationBug) => fun("Read line admission")
  .inputs({ body: nat, line: nat, notice: nat, cap: nat, count: nat, limit: nat })
  .assume(({ body, cap }) => body.atMost(cap))
  .returns(({ body, line, notice, cap, count, limit }) => {
    const size = body.plus(line).plus(bug === "ignore notice bytes" ? 0 : notice);
    const fits = bug === "refuse a fitting line" ? size.lt(cap) : size.atMost(cap);
    const allowed = bug === "ignore line limit" ? fits : fits.and(count.lt(limit));
    return { admit: when(allowed, 1, 0), bytes: when(allowed, bug === "drop the admitted line's bytes" ? body : body.plus(line),
      bug === "charge a refused line" ? body.plus(line) : body) };
  });

const page = (bug?: ReadContinuationBug) => fun("Read page continuation")
  .inputs({ offset: nat, count: nat, total: nat })
  .assume(({ offset, count, total }) => offset.atLeast(1).and(count.atLeast(1)).and(offset.plus(count).atMost(total.plus(1))))
  .returns(({ offset, count, total }) => {
    const end = offset.plus(count).minus(bug === "misstate the last line" ? 0 : 1);
    const next = offset.plus(count).plus(bug === "skip the next line" ? 1 : 0);
    const more = end.lt(total);
    const notice = bug === "omit continuation notice" ? 0
      : bug === "invent a notice" ? 1 : when(more, 1, 0);
    return { end, next, more: when(more, 1, 0), notice };
  });

export const readContinuationKernels = (bug?: ReadContinuationBug): Kernel[] => {
  const a = admission(bug);
  const p = page(bug);
  return [
    { id: "readAdmission", fun: a, decisions: [
      a.law("byte_accounting: an admitted line adds its bytes and a refused line leaves the body unchanged", () => [],
        (o, e) => o.bytes.eq(when(o.admit.eq(1), e.body.plus(e.line), e.body))),
      a.law("byte_cap: an admitted line and its notice fit the byte cap", () => [],
        (o, e) => o.admit.eq(1).implies(o.bytes.plus(e.notice).atMost(e.cap))),
      a.law("line_cap: an admitted line stays within the line limit", () => [],
        (o, e) => o.admit.eq(1).implies(e.count.lt(e.limit))),
      a.law("fits: a line that fits both caps is admitted", () => [],
        (o, e) => e.count.lt(e.limit).and(e.body.plus(e.line).plus(e.notice).atMost(e.cap)).implies(o.admit.eq(1))),
    ] },
    { id: "readPage", fun: p, decisions: [
      p.law("last_line: the last line is the start plus the emitted count minus one", () => [],
        (o, e) => o.end.plus(1).eq(e.offset.plus(e.count))),
      p.law("next_offset: the next offset is one past the last line emitted", () => [],
        (o) => o.next.eq(o.end.plus(1))),
      p.law("pages_visit_once: the next page starts after exactly the lines emitted", () => [],
        (o, e) => o.next.eq(e.offset.plus(e.count)).and(o.next.gt(e.offset)).and(o.next.atMost(e.total.plus(1)))),
      p.law("notice_exactly: a notice appears exactly when a line is left out", () => [],
        (o, e) => o.notice.eq(when(e.offset.plus(e.count).atMost(e.total), 1, 0))),
      p.law("more_exactly: continuation is offered exactly when lines remain", () => [],
        (o, e) => o.more.eq(when(e.offset.plus(e.count).atMost(e.total), 1, 0))),
    ] },
  ];
};

export const READ_CONTINUATION_BUGS: ReadContinuationBug[] = [
  "ignore notice bytes", "ignore line limit", "refuse a fitting line", "skip the next line",
  "misstate the last line", "omit continuation notice", "invent a notice", "drop the admitted line's bytes", "charge a refused line",
];
