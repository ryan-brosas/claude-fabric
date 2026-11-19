import { defineBuiltin } from "../../registry/builtin.ts";

// The session store as a program sees it. These are not tools: the worker holds the values and the
// host commits a run's writes only after the program succeeds (src/kernel/store.ts and
// src/stages/store.ts). The declarations here are the one definition the check and DESCRIPTION are
// printed from.
export const Store = defineBuiltin({
  name: "store",
  signature: "function store(key: string, value: unknown): void",
  call: "store(key, value) -> void",
  doc: "Saves a JSON value under key for this session's later calls; undefined removes the key.",
});

export const Load = defineBuiltin({
  name: "load",
  signature: "function load<T = unknown>(key: string): T | undefined",
  call: "load(key) -> value | undefined",
  doc: "Returns a copy of the JSON value saved under key, or undefined.",
});

/** The store globals, in the order a program sees them. This list is the only one. */
export const STORE = [Store, Load];
