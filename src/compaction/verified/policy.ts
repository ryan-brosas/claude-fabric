// Copied from pi-fabric (MIT, Tom X Nguyen) src/verified/policy.ts at d331f629; kept only the sampling decision the summary's bounds call.
import { VERIFIED_NAT_MAX } from "./nat.ts";
import { sampleWithin as sampleMachine } from "./generated/policy.js";

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const yes = (value: number | undefined): boolean => value === 1;

export const acceptSampleAccounting = (total: number, retained: number, omitted: number, limit: number): boolean =>
  [total, retained, omitted, limit].every(isNatural) && retained + omitted <= VERIFIED_NAT_MAX &&
  yes(sampleMachine.step({}, sampleMachine.init({}), { total, retained, omitted, limit }).scalars["out.within"]);
