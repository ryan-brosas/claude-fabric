import { describe, expect, test } from "bun:test";
import { resetStore } from "../src/cache/remember";
import { profileFor } from "../src/services/users";
import { sessionFor } from "../src/services/sessions";

describe("services", () => {
  test("profiles are cached", () => {
    resetStore();
    expect(profileFor("u_1")).toBe(profileFor("u_1"));
    expect(profileFor("u_1").plan).toBe("pro");
  });

  test("unknown users throw", () => {
    resetStore();
    expect(() => profileFor("nobody")).toThrow();
  });

  test("sessions resolve", () => {
    resetStore();
    expect(sessionFor("s_1")?.userId).toBe("u_1");
  });
});
