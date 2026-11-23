import { describe, expect, test } from "bun:test";
import { hmacHex, safeCompare, signPayload } from "../src/sign";

describe("signing", () => {
  test("hmacHex is stable", () => {
    expect(hmacHex("secret", "hello")).toBe(hmacHex("secret", "hello"));
    expect(hmacHex("secret", "hello")).not.toBe(hmacHex("other", "hello"));
    expect(hmacHex("secret", "hello")).toHaveLength(64);
  });

  test("signPayload signs the body", () => {
    expect(signPayload("s", "body")).toBe(hmacHex("s", "body"));
  });

  test("safeCompare compares strings of any length", () => {
    expect(safeCompare("abc", "abc")).toBe(true);
    expect(safeCompare("abc", "abd")).toBe(false);
    expect(safeCompare("abc", "abcd")).toBe(false);
  });
});
