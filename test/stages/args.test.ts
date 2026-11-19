import { expect, test } from "bun:test";
import { prepareArguments } from "../../src/stages/args.ts";

test("keeps canonical arguments identical", () => {
  const input = { code: "return 1;" };
  expect(prepareArguments(input)).toBe(input);
  const withPayloads = { code: "return 1;", payloads: { body: "ok" } };
  expect(prepareArguments(withPayloads)).toBe(withPayloads);
});

test("wraps a bare program string as code", () => {
  expect(prepareArguments("return 1;")).toEqual({ code: "return 1;" });
});

test("joins a program sent as lines and leaves a malformed array alone", () => {
  expect(prepareArguments({ code: ["const x = 1;", "return x;"] })).toEqual({ code: "const x = 1;\nreturn x;" });
  const malformed = { code: ["return ", 1] };
  expect(prepareArguments(malformed)).toBe(malformed);
});

test("drops null optional keys but keeps a null program for the strict check to name", () => {
  expect(prepareArguments({
    code: null,
    payloads: null,
    strings: null,
    display: null,
    tokenBudget: 10,
    agentBudget: undefined,
  })).toEqual({ code: null });
});

test("drops the keys this tool does not declare", () => {
  expect(prepareArguments({
    code: "return 1;",
    tokenBudget: 10,
    agentBudget: 2,
    resultFormat: "text",
    background: true,
    max_output_tokens: 500,
  })).toEqual({ code: "return 1;" });
});

test("normalizes display shorthands", () => {
  expect(prepareArguments({ code: "return 1;", display: "Probe" })).toEqual({ code: "return 1;", display: { name: "Probe" } });
  expect(prepareArguments({ code: "return 1;", display: '{"name":"Probe","description":"check"}' }))
    .toEqual({ code: "return 1;", display: { name: "Probe", description: "check" } });
  expect(prepareArguments({ code: "return 1;", display: { name: "Probe", extra: true } }))
    .toEqual({ code: "return 1;", display: { name: "Probe" } });
  expect(prepareArguments({ code: "return 1;", display: { extra: true } })).toEqual({ code: "return 1;" });
  expect(prepareArguments({ code: "return 1;", display: "" })).toEqual({ code: "return 1;" });
});

test("remaps the strings alias onto payloads", () => {
  expect(prepareArguments({ code: "return π.body;", strings: { body: "ok" } }))
    .toEqual({ code: "return π.body;", payloads: { body: "ok" } });
  expect(prepareArguments({ code: "return π.body;", payloads: { body: "canonical" }, strings: { body: "alias" } }))
    .toEqual({ code: "return π.body;", payloads: { body: "canonical" } });
});

test("parses payload maps sent as JSON text, once or twice encoded", () => {
  const payload = { lifecycle: "#!/bin/sh\n# inventory" };
  expect(prepareArguments({ code: "return π.lifecycle;", payloads: JSON.stringify(payload) }))
    .toEqual({ code: "return π.lifecycle;", payloads: payload });
  expect(prepareArguments({ code: "return π.body;", strings: JSON.stringify(JSON.stringify({ body: "ok" })) }))
    .toEqual({ code: "return π.body;", payloads: { body: "ok" } });
});

test("moves a malformed payload map to the canonical key for the strict check to name", () => {
  expect(prepareArguments({ code: "return 1;", strings: "not-json" })).toEqual({ code: "return 1;", payloads: "not-json" });
  expect(prepareArguments({ code: "return 1;", payloads: '["lifecycle"]' })).toEqual({ code: "return 1;", payloads: '["lifecycle"]' });
  expect(prepareArguments({ code: "return 1;", strings: '{"n":1}' })).toEqual({ code: "return 1;", payloads: '{"n":1}' });
});

test("leaves a value that is not an envelope alone", () => {
  for (const value of [null, 42, ["return 1;"], undefined]) expect(prepareArguments(value)).toBe(value as unknown);
});
