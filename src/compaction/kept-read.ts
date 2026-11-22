// The live cut stays untouched. After the summary is accepted, replace only a
// provably text-only whole-file Read result. Handles are opaque, so the original
// transcript must independently identify both the call and the recoverable row.
import { utf8Bytes } from "./bounds.ts";
import type { ClaudeMessage, ClaudeToolUse } from "./from-claude.ts";
import { keptReadStub } from "./verified/generated/kept-read-stub.js";
import { entryText, transcriptChain, type TranscriptRow } from "../recall/transcript.ts";

export const READ_STUB_THRESHOLD = 16_384;
export const READ_STUB_MAX_BYTES = 1_024;

/** Decide whether a lower bound on a stub's byte length could fit the cap. */
export function readStubMayFit(minBytes: number): boolean {
  // Make the hypothetical original large enough that only the cap can reject.
  const original = Math.max(minBytes, READ_STUB_THRESHOLD + 1);
  const facts = { original, stub: minBytes, threshold: READ_STUB_THRESHOLD, cap: READ_STUB_MAX_BYTES,
    namesPath: 0, namesBytes: 0, namesEntry: 0, namesDigest: 0, recoverable: 0, verifiedCall: 0 };
  return keptReadStub.step({}, keptReadStub.init({}), facts).scalars["out.consider"] === 1;
}

type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const blocks = (row: RecordValue): unknown[] => Array.isArray(obj(row.message).content) ? obj(row.message).content as unknown[] : [];
export const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.every((item) => obj(item).type === "text" && typeof obj(item).text === "string"
    && Object.keys(obj(item)).every((key) => key === "type" || key === "text"))) return undefined;
  return content.map((item) => obj(item).text as string).join("\n");
};

// SHA-256 compression adapted from Dmitry Chestnykh's fast-sha256 (Unlicense,
// https://github.com/dchest/fast-sha256-js). The hook environment has Web Crypto
// but no synchronous digest; keeping the compactor synchronous needs this subset.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function readDigest(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, bytes.length << 3);
  const v = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  for (let pos = 0; pos < padded.length; pos += 64) {
    let [a, b, c, d, e, f, g, h] = v as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(pos + i * 4);
    for (let i = 16; i < 64; i++) {
      let u = w[i - 2]!;
      const t1 = (u >>> 17 | u << 15) ^ (u >>> 19 | u << 13) ^ (u >>> 10);
      u = w[i - 15]!;
      const t2 = (u >>> 7 | u << 25) ^ (u >>> 18 | u << 14) ^ (u >>> 3);
      w[i] = (t1 + w[i - 7]! | 0) + (t2 + w[i - 16]! | 0);
    }
    for (let i = 0; i < 64; i++) {
      const t1 = (((((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7))
        + ((e & f) ^ (~e & g))) | 0) + ((h + ((SHA256_K[i]! + w[i]!) | 0)) | 0)) | 0;
      const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10))
        + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    v[0] = v[0]! + a; v[1] = v[1]! + b; v[2] = v[2]! + c; v[3] = v[3]! + d;
    v[4] = v[4]! + e; v[5] = v[5]! + f; v[6] = v[6]! + g; v[7] = v[7]! + h;
  }
  return Array.from(v, (n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

/** The exact public stub format, shared by the writer and transcript verifier. */
export const buildKeptReadStub = (path: string, entryId: string, original: string): string =>
  `[Compaction removed this earlier Read result to save context. The Read had returned the whole file: ${utf8Bytes(original)} UTF-8 bytes. Nothing was cut by the Read tool.]\nFile: ${JSON.stringify(path)}\nTranscript entry: ${entryId}\nSHA-256: ${readDigest(original)}\nIf you need the text again, call Read on the file with no offset or limit; it returns the whole file.`;

/** The writer and resolver accept exactly the same whole-file Read arguments. */
export function wholeReadPath(use: ClaudeToolUse): string | undefined {
  const input = obj(use.input), path = input.file_path;
  return use.tool === "Read" && typeof path === "string" && !!path
    && Object.keys(input).every((key) => key === "file_path" || key === "allow_large")
    && (!("allow_large" in input) || typeof input.allow_large === "boolean") ? path : undefined;
}

interface Candidate { message: ClaudeMessage; use: ClaudeToolUse; callHandle: string; id: string; path: string; original: number; text: string; digest: string }

function decision(candidate: Pick<Candidate, "id" | "path" | "original" | "text" | "digest">, recoverable: boolean, verifiedCall: boolean) {
  const { id, path, original, text } = candidate;
  const facts = { original, stub: utf8Bytes(text), threshold: READ_STUB_THRESHOLD, cap: READ_STUB_MAX_BYTES,
    namesPath: Number(text.includes(`\nFile: ${JSON.stringify(path)}\n`)),
    namesBytes: Number(text.includes(`whole file: ${original} UTF-8 bytes.`)),
    namesEntry: Number(text.includes(`\nTranscript entry: ${id}\n`)),
    namesDigest: Number(text.includes(`\nSHA-256: ${candidate.digest}\n`)),
    recoverable: Number(recoverable), verifiedCall: Number(verifiedCall) };
  return keptReadStub.step({}, keptReadStub.init({}), facts).scalars;
}

/** The writer and resolver share the complete source-row and size eligibility decision. */
export function eligibleKeptRead(use: ClaudeToolUse, row: TranscriptRow | undefined, id: string, original: string, text: string): boolean {
  const path = wholeReadPath(use);
  if (!path || !id || /[\r\n]/.test(id)) return false;
  const contents = blocks(row ?? {}), block = obj(contents[0]), entry = row ? entryText(row) : undefined;
  const record = obj(row?.toolUseResult), file = obj(record.file);
  const recoverable = !!row && row.isSidechain !== true && row.type === "user" && contents.length === 1
    && entry?.kind === "tool_result" && entry.text === `toolResult: ${original}`
    && block.type === "tool_result" && block.tool_use_id === use.tool_use_id && block.is_error !== true
    && textOf(block.content) === original
    && Object.keys(block).every((key) => ["type", "tool_use_id", "content", "is_error"].includes(key))
    && record.type === "text" && file.startLine === 1 && typeof file.numLines === "number" && file.numLines === file.totalLines;
  const digest = readDigest(original);
  const candidate = { id, path, original: utf8Bytes(original), text, digest };
  return text === buildKeptReadStub(path, id, original) && decision(candidate, recoverable, true)["out.replace"] === 1;
}

/** Candidates come solely from the already-selected tail, not the summary. */
function candidates(messages: readonly ClaudeMessage[]): Candidate[] {
  const calls = new Map<string, { use: ClaudeToolUse; handle: string; index: number }[]>();
  const resultCounts = new Map<string, number>();
  messages.slice(1).forEach((m, index) => {
    for (const use of m.toolUses ?? []) {
      const matches = calls.get(use.tool_use_id) ?? [];
      if (m.role === "assistant" && m.handle) matches.push({ use, handle: m.handle, index });
      calls.set(use.tool_use_id, matches);
    }
    for (const result of m.toolResults ?? []) resultCounts.set(result.tool_use_id, (resultCounts.get(result.tool_use_id) ?? 0) + 1);
  });
  const found: Candidate[] = [];
  for (const [index, message] of messages.slice(1).entries()) {
    if (message.role !== "user" || message.text !== "" || message.toolUses.length !== 0 || !message.handle
      || /[\r\n]/.test(message.handle) || message.toolResults?.length !== 1) continue;
    const result = message.toolResults[0]!;
    const matches = calls.get(result.tool_use_id) ?? [];
    if (matches.length !== 1 || matches[0]!.index >= index || resultCounts.get(result.tool_use_id) !== 1
      || result.isError) continue;
    const { use, handle: callHandle } = matches[0]!;
    const path = wholeReadPath(use);
    if (!path) continue;
    const original = utf8Bytes(result.text), digest = readDigest(result.text);
    const text = buildKeptReadStub(path, message.handle, result.text);
    const candidate = { message, use, callHandle, id: message.handle, path, original, text, digest };
    // Verification has not happened yet; only the size prefilter is read here.
    if (decision(candidate, false, false)["out.consider"] === 1) found.push(candidate);
  }
  return found;
}

export const hasKeptReadCandidate = (messages: readonly ClaudeMessage[]): boolean => candidates(messages).length > 0;

/** Only rebuild a row once raw transcript blocks rule out hidden images and other content. */
export function stubKeptReads(messages: readonly ClaudeMessage[], transcript: string | ReadonlyMap<string, TranscriptRow>): ClaudeMessage[] {
  const planned = candidates(messages);
  if (!planned.length) return [...messages];
  // The rebuild already parsed and validated these physical non-sidechain rows.
  // For an initial compaction, validate the transcript once here instead.
  const rows = typeof transcript === "string" ? transcriptChain(transcript).rows : transcript;
  const replacements = new Map<ClaudeMessage, string>();
  for (const candidate of planned) {
    const { id, callHandle, use, message, text } = candidate;
    const row = rows.get(id), call = rows.get(callHandle);
    const callBlocks = blocks(call ?? {}).map(obj).filter((b) => b.type === "tool_use" && b.id === use.tool_use_id);
    const verifiedCall = !!call && call.isSidechain !== true && call.type === "assistant" && callBlocks.length === 1 && callBlocks[0]!.name === "Read"
      && JSON.stringify(callBlocks[0]!.input) === JSON.stringify(use.input);
    const result = message.toolResults![0]!;
    if (verifiedCall && eligibleKeptRead(use, row, id, result.text, text)) replacements.set(message, text);
  }
  return messages.map((message) => {
    const text = replacements.get(message);
    if (text === undefined) return message;
    // A handled message is returned whole by the engine; dropping only its handle
    // tells the engine to construct this verified text-only tool-result row.
    const { handle, ...built } = message;
    void handle;
    return { ...built, toolResults: [{ ...message.toolResults![0]!, text }] };
  });
}
