export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface FixedClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function fixedClock(start: number): FixedClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}
