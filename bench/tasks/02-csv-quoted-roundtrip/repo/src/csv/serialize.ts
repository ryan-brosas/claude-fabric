export interface StringifyOptions {
  delimiter?: string;
}

const QUOTE = '"';

export function escapeField(value: string, delimiter = ","): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes(QUOTE) ||
    value.includes("\n") ||
    value.includes("\r");
  if (!needsQuotes) return value;
  return QUOTE + value + QUOTE;
}

export function stringifyCsv(rows: string[][], options: StringifyOptions = {}): string {
  const delimiter = options.delimiter ?? ",";
  return rows
    .map((row) => row.map((cell) => escapeField(cell, delimiter)).join(delimiter))
    .join("\n");
}
