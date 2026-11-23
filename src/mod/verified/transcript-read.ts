// The law and compiled decision live in proofs/transcript-read.ts and generated/transcript-read.js.
import { transcriptRead } from "./generated/transcript-read.js";

// Measured with the Carry, ranged 2 MiB base64 reads, decoding, rebuilding and compacting synthetic histories.
export const TRANSCRIPT_READ_LIMIT = 16 * 1024 * 1024;

/** Invalid sizes are encoded as a false validity fact and a natural placeholder. */
export const transcriptReadProblem = (size: number): string | undefined => {
  const valid = Number.isSafeInteger(size) && size >= 0;
  const out = transcriptRead.step({}, transcriptRead.init({}), {
    size: valid ? size : 0, limit: TRANSCRIPT_READ_LIMIT, valid: valid ? 1 : 0,
  }).scalars;
  if (out["out.read"] === 1) return undefined;
  return valid ? `transcript size ${size} exceeds read bound ${TRANSCRIPT_READ_LIMIT} bytes`
    : `invalid transcript size ${size}; read bound ${TRANSCRIPT_READ_LIMIT} bytes`;
};
