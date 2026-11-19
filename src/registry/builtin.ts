// A guest global a program calls that is not a tool: nothing crosses the bridge for it. Like an
// action, it is defined once and everything a program or the model sees is printed from that
// definition (see generate.ts).
export interface Builtin {
  /** The name a program calls. */
  name: string;
  /** The declared signature after `declare `, so the check gives a program exactly this shape. */
  signature: string;
  /** How the model sees the call in DESCRIPTION, before the documented sentence. */
  call: string;
  /** One plain sentence: what it does. */
  doc: string;
}

export function defineBuiltin(spec: Builtin): Builtin {
  return spec;
}
