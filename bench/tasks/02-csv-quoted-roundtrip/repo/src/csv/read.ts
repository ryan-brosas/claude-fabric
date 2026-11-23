import { normalizeField } from "./fields";
import { parseCsv } from "./parse";
import type { ReadOptions } from "../types";

export function readCsv(text: string, options: ReadOptions = {}): string[][] {
  const trim = options.trim ?? true;
  return parseCsv(text, options).map((row) => row.map((cell) => normalizeField(cell, trim)));
}
