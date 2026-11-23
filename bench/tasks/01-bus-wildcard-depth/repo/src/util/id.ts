let counter = 0;

export function nextId(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

export function resetIds(): void {
  counter = 0;
}
