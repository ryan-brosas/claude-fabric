export interface ParseOptions {
  delimiter?: string;
  quote?: string;
}

export interface ReadOptions extends ParseOptions {
  trim?: boolean;
}

export class CsvError extends Error {
  readonly row: number;

  constructor(message: string, row: number) {
    super(message);
    this.name = "CsvError";
    this.row = row;
  }
}
