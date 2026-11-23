import { memoize } from "../cache/remember";
import type { SearchRow } from "../types";

const index: SearchRow[] = [
  { id: "p_1", title: "Blue kettle" },
  { id: "p_2", title: "Red kettle" },
];

export function search(query: string, page: number): SearchRow[] {
  return memoize(`search:${query}:${page}`, () =>
    index.filter((row) => row.title.toLowerCase().includes(query.toLowerCase())),
  );
}
