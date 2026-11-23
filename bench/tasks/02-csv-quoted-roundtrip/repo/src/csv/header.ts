import { readCsv } from "./read";
import type { ReadOptions } from "../types";

export interface ReadObjectsOptions extends ReadOptions {
  header?: boolean;
}

export function readObjects(
  text: string,
  options: ReadObjectsOptions = {},
): Record<string, string>[] {
  const rows = readCsv(text, options);
  if (rows.length === 0) return [];
  const header = rows[0].map((name) => name.trim());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}
