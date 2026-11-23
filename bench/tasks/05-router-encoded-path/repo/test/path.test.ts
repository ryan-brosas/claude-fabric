import { describe, expect, test } from "bun:test";
import { normalizePath, PathError, splitPath } from "../src/path";

describe("splitPath", () => {
  test("drops empty segments", () => {
    expect(splitPath("/a//b/")).toEqual(["a", "b"]);
  });
});

describe("normalizePath", () => {
  test("collapses duplicate slashes and trailing slashes", () => {
    expect(normalizePath("/users//42/")).toBe("/users/42");
  });

  test("ignores the query string", () => {
    expect(normalizePath("/users/42?full=1")).toBe("/users/42");
  });

  test("rejects traversal", () => {
    expect(() => normalizePath("/files/..")).toThrow(PathError);
  });

  test("rejects invalid escapes", () => {
    expect(() => normalizePath("/files/%zz")).toThrow(PathError);
  });
});
