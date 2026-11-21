// The ordering gate checks each one-based matched position and the suffix layout.
// ID equality and visiting every current outcome belong to the adapter.
import { restoreOrder } from "./generated/restore-order.js";

export interface RestorePosition {
  previous: number;
  position: number;
  expectedPosition: number;
  expectedFirst: number;
  actualFirst: number;
  expectedLength: number;
  actualLength: number;
  matches: boolean;
}

export function acceptRestorePosition(facts: RestorePosition): boolean {
  const state = restoreOrder.step({}, restoreOrder.init({}), { ...facts, matches: Number(facts.matches) });
  return state.scalars["out.apply"] === 1;
}
