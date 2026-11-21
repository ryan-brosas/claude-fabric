// Copied from pi-fabric (MIT, Tom X Nguyen) src/verified/policy.ts at d331f629; sampleWithin retained.
// userPriority is the user-message selection decision for this port.
import { VERIFIED_NAT_MAX } from "./nat.ts";
import { sampleWithin as sampleMachine, userPriority as priorityMachine, userShortSwap as shortSwapMachine } from "./generated/policy.js";

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const yes = (value: number | undefined): boolean => value === 1;

export const acceptSampleAccounting = (total: number, retained: number, omitted: number, limit: number): boolean =>
  [total, retained, omitted, limit].every(isNatural) && retained + omitted <= VERIFIED_NAT_MAX &&
  yes(sampleMachine.step({}, sampleMachine.init({}), { total, retained, omitted, limit }).scalars["out.within"]);

export const shortUserSwap = (pressure: boolean, sameClass: boolean, candidateBytes: number, slotBytes: number): boolean => {
  if (![candidateBytes, slotBytes].every((value) => isNatural(value) && value <= VERIFIED_NAT_MAX)) {
    throw new RangeError("short user swap needs bounded natural inputs");
  }
  return yes(shortSwapMachine.step({}, shortSwapMachine.init({}), {
    pressure: Number(pressure), sameClass: Number(sameClass), candidateBytes, slotBytes,
  }).scalars["out.swap"]);
};

export const userBefore = (aDistinct: boolean, bDistinct: boolean, aIndex: number, bIndex: number): boolean => {
  if (![aIndex, bIndex].every((value) => isNatural(value) && value <= VERIFIED_NAT_MAX)) {
    throw new RangeError("user sample priority needs bounded natural inputs");
  }
  return yes(priorityMachine.step({}, priorityMachine.init({}), { aDistinct: Number(aDistinct), bDistinct: Number(bDistinct), aIndex, bIndex }).scalars["out.before"]);
};
