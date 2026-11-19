import { z } from "zod";
import type { AnyAction } from "./action.ts";
import type { Builtin } from "./builtin.ts";

// Everything a program tool (or a guest global that is not a tool) needs beyond its own
// definition, printed from that definition: the types the checker gives a program, the lines of the
// model-facing description, and the runtime argument check.

// The slices of JSON Schema this repo's schemas can produce.
interface Schema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

const schemaOf = (value: z.ZodType): Schema => z.toJSONSchema(value) as unknown as Schema;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (name: string): string => (IDENT.test(name) ? name : JSON.stringify(name));

function typeText(schema: Schema): string {
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeText).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const item = typeText(schema.items ?? {});
      return (item.includes(" | ") ? "(" + item + ")" : item) + "[]";
    }
    case "object": {
      const fields = Object.entries(schema.properties ?? {})
        .map(([name, field]) => key(name) + ((schema.required ?? []).includes(name) ? "" : "?") + ": " + typeText(field));
      return "{ " + fields.join("; ") + " }";
    }
    default: return "unknown";
  }
}

const fields = (schema: Schema): [string, Schema][] => Object.entries(schema.properties ?? {});
const isRequired = (schema: Schema, name: string): boolean => (schema.required ?? []).includes(name);

/** The field names of an action's input, in declaration order: what a program may pass. */
export function inputFields(action: AnyAction): string[] {
  return fields(schemaOf(action.input)).map(([name]) => name);
}

// An object output gets a name, so a program meets BashResult in its own errors, not a shape.
function outputOf(name: string, schema: Schema, declarations: string[]): string {
  if (schema.properties) {
    declarations.push("");
    declarations.push("interface " + name + "Result {");
    for (const [field, value] of fields(schema)) {
      declarations.push("  " + key(field) + (isRequired(schema, field) ? "" : "?") + ": " + typeText(value) + ";");
    }
    declarations.push("}");
    return name + "Result";
  }
  return typeText(schema);
}

const PRINT = [
  "/** Adds a line to the output. */",
  "declare function print(...values: unknown[]): void;",
  "/** String payloads passed in the same call's `payloads` argument. */",
  "declare const π: Readonly<Record<string, string>>;",
  // The two timer lines are copied from pi-fabric (MIT, Tom X Nguyen) src/runtime/guest-types.ts
  // at d331f629. The Worker has the timers; only the check lacked them, so a program that waited
  // between calls failed before it ran. A pending timer dies with the Worker at the call's end.
  "/** Runs handler after timeout ms, within this call's time limit. */",
  "declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;",
  "declare function clearTimeout(handle: number): void;",
].join("\n");

const HEADER = "// Globals a fabric_exec program sees. Names and fields follow Claude Code's own tools.";

export function guestTypes(actions: readonly AnyAction[], globals: readonly Builtin[] = [], extras: readonly string[] = []): string {
  const blocks: string[] = [];
  for (const action of actions) {
    const input = schemaOf(action.input);
    const declarations: string[] = ["interface " + action.name + "Input {"];
    for (const [field, value] of fields(input)) {
      declarations.push("  " + key(field) + (isRequired(input, field) ? "" : "?") + ": " + typeText(value) + ";");
    }
    declarations.push("}");
    const out = outputOf(action.name, schemaOf(action.output), declarations);
    declarations.push("");
    declarations.push("/** " + action.doc + " */");
    if (action.positional.length >= 2) {
      declarations.push("declare function " + action.name + "(input: " + action.name + "Input): Promise<" + out + ">;");
      const params = action.positional
        .map((field) => field + ": " + typeText(input.properties?.[field] ?? {}))
        .join(", ");
      declarations.push("declare function " + action.name + "(" + params + "): Promise<" + out + ">;");
    } else {
      const first = action.positional[0] ?? "input";
      const shorthand = typeText(input.properties?.[first] ?? {});
      const param = shorthand === "string" ? "string | " + action.name + "Input" : action.name + "Input";
      declarations.push("declare function " + action.name + "(input: " + param + "): Promise<" + out + ">;");
    }
    blocks.push(declarations.join("\n"));
  }
  if (globals.length) blocks.push(globals.map((builtin) => "/** " + builtin.doc + " */\ndeclare " + builtin.signature + ";").join("\n"));
  // A surface printed from runtime data (the session's MCP catalog) comes in as ready text.
  for (const extra of extras) blocks.push(extra);
  blocks.push(PRINT);
  return HEADER + "\n\n" + blocks.join("\n\n") + "\n";
}

export function toolLines(actions: readonly AnyAction[]): string[] {
  return actions.map((action) => {
    const input = schemaOf(action.input);
    const shown = fields(input)
      .map(([field]) => key(field) + (isRequired(input, field) ? "" : "?"))
      .join(", ");
    const output = schemaOf(action.output);
    const out = output.properties ? "{" + Object.keys(output.properties).join(", ") + "}" : typeText(output);
    return "- " + action.name + "({" + shown + "}) -> " + out + ". " + action.doc;
  });
}

/** The model-facing lines for the guest globals that are not tools: one line each, then its doc. */
export function globalLines(globals: readonly Builtin[]): string[] {
  return globals.map((builtin) => "- " + builtin.call + ". " + builtin.doc);
}

// A missing or empty value reads like the message this repo gave before the schema did the check.
function issue(action: AnyAction, input: Schema, given: Record<string, unknown>, error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return action.name + ": invalid input";
  const field = first.path.map(String).join(".") || "input";
  const expected = typeText(input.properties?.[field] ?? {});
  const value = given[field];
  if (isRequired(input, field) && (value === undefined || value === "")) return action.name + ": " + field + " is required (" + expected + ")";
  return action.name + ": " + field + " " + first.message.replace(/^Invalid input:\s*/, "");
}

// One object argument is the input; otherwise arguments map onto the positional field names.
// Unknown keys are dropped by the object schema, not treated as errors.
export function parseArgs(action: AnyAction, raw: unknown[]): z.output<z.ZodObject<z.ZodRawShape>> {
  const input = schemaOf(action.input);
  let candidate: Record<string, unknown>;
  if (raw.length === 1 && typeof raw[0] === "object" && raw[0] !== null) {
    candidate = { ...(raw[0] as Record<string, unknown>) };
  } else {
    candidate = {};
    raw.forEach((value, i) => {
      const field = action.positional[i];
      if (field !== undefined) candidate[field] = value;
    });
  }
  const parsed = action.input.safeParse(candidate);
  if (!parsed.success) throw new Error(issue(action, input, candidate, parsed.error));
  return parsed.data;
}
