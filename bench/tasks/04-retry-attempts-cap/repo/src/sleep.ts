export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => Bun.sleep(ms);
