import { CsvError, type ParseOptions } from "../types";

export function parseCsv(text: string, options: ParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ",";
  const quote = options.quote ?? '"';
  if (delimiter.length !== 1) throw new CsvError("delimiter must be one character", 0);
  if (quote.length !== 1) throw new CsvError("quote must be one character", 0);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let index = 0;
  let quoted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === quote) {
        if (text[index + 1] === quote) {
          field += quote;
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === quote && field.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r" && text[index + 1] === "\n") {
      endRow();
      index += 2;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) throw new CsvError(`unterminated quoted field in row ${rows.length + 1}`, rows.length + 1);
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}
