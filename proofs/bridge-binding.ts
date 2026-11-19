// The rule a mod passes before it uses a bridge: the secret file must name the mod's own session.
// Bridge files are named by a short prefix of the session id, so two sessions can share a name;
// the server's lock lets only one of them listen, and this rule keeps the other session's mod
// from reading that server's secret and running its jobs. Per read the rule takes two facts:
//
// - the session id written in the secret file is the reading mod's own;
// - the file holds a secret at all.
//
// The mod uses the bridge exactly when both hold. The compiled machine is in
// src/kernel/verified/bridge-binding.ts, and `boundSecret` in src/bridge/contract.ts hands the mod
// a secret only through its verdict.
import { bool, fun, no, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.ts";

export type BridgeBindingBug =
  | "any session's secret is used"
  | "an empty secret is used"
  | "a deny-all rule refuses every session";

const binding = (bug?: BridgeBindingBug) => fun("bridge binding")
  .inputs({ sameSession: bool, hasSecret: bool })
  .returns(({ sameSession, hasSecret }) => {
    const same = bug === "any session's secret is used" ? yes : sameSession;
    const has = bug === "an empty secret is used" ? yes : hasSecret;
    const use = bug === "a deny-all rule refuses every session" ? no : same.and(has);
    return { used: when(use, 1, 0) };
  });

export const bridgeBindingKernels = (bug?: BridgeBindingBug): Kernel[] => {
  const b = binding(bug);
  return [{
    id: "bridgeBinding",
    fun: b,
    decisions: [
      b.law("used_iff_own_session_and_secret: a mod uses a bridge exactly when its secret file names the mod's own session and holds a secret", () => [],
        (o, e) => o.used.eq(when(e.sameSession.and(e.hasSecret), 1, 0))),
    ],
  }];
};

export const BRIDGE_BINDING_BUGS: BridgeBindingBug[] = [
  "any session's secret is used",
  "an empty secret is used",
  "a deny-all rule refuses every session",
];
