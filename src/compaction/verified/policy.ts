// Copied from pi-fabric (MIT, Tom X Nguyen) src/verified/policy.ts at d331f629; sampleWithin retained.
// The earlier-user selection is checked by the machine in proofs/policy.ts.
import { VERIFIED_NAT_MAX } from "./nat.ts";
import { sampleWithin as sampleMachine, userSelection } from "./generated/policy.js";

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const yes = (value: number | undefined): boolean => value === 1;

export const acceptSampleAccounting = (total: number, retained: number, omitted: number, limit: number): boolean =>
  [total, retained, omitted, limit].every(isNatural) && retained + omitted <= VERIFIED_NAT_MAX &&
  yes(sampleMachine.step({}, sampleMachine.init({}), { total, retained, omitted, limit }).scalars["out.within"]);

/** A committed selection must also pass the machine's final rendered-notice check. */
export interface UserSelectionGate {
  noticeRequired: boolean;
  omitted: number;
  acceptSummary: (summary: string, goalBlock: string, goalOffset: number, marker: string, header: string) => boolean;
}

export const checkUserSelection = (texts: readonly string[], selected: ReadonlySet<number>): UserSelectionGate => {
  const total = texts.length;
  if (total > VERIFIED_NAT_MAX - 1 || [...selected].some((index) => !isNatural(index) || index >= total)) {
    throw new RangeError("user selection needs bounded source ordinals");
  }
  const params = { total };
  const last = new Map(texts.map((text, index) => [text, index]));
  let state = userSelection.init(params);
  for (let index = total - 1; index >= 0; index--) {
    state = userSelection.step(params, state, { op: 0, index, selected: Number(selected.has(index)), distinct: Number(last.get(texts[index]!) === index), notice: 0 });
    if (state.scalars.phase !== 0) throw new Error("fabric: user selection failed its verified check");
  }
  state = userSelection.step(params, state, { op: 1, index: 0, selected: 0, distinct: 0, notice: 0 });
  if (state.scalars.phase !== 1) throw new Error("fabric: user selection failed its verified check");
  const noticeRequired = yes(state.scalars.noticeRequired);
  const omitted = state.scalars.omitted!;
  return {
    noticeRequired,
    omitted,
    acceptSummary: (summary, goalBlock, goalOffset, marker, header) => {
      // Bind the marker to the goal block at its actual final-text offset, not
      // to an identical quotation elsewhere in the summary.
      const framing = `${header}\n${marker}`;
      const notice = marker !== "" && (goalBlock === framing || goalBlock.startsWith(`${framing}\n\n`))
        && summary.slice(goalOffset, goalOffset + goalBlock.length) === goalBlock;
      const final = userSelection.step(params, state, { op: 2, index: 0, selected: 0, distinct: 0, notice: Number(notice) });
      return final.scalars.phase === 3;
    },
  };
};
