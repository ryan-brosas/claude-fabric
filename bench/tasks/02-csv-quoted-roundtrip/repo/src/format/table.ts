export interface TableOptions {
  padding?: number;
}

export function formatTable(rows: string[][], options: TableOptions = {}): string {
  const padding = options.padding ?? 2;
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    widths[column] = Math.max(...rows.map((row) => (row[column] ?? "").length));
  }
  return rows
    .map((row) =>
      row
        .map((cell, column) => (cell ?? "").padEnd(widths[column] + padding))
        .join("")
        .trimEnd(),
    )
    .join("\n");
}
