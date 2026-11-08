import { describe, expect, it } from "vitest";
import { actionEventTypes, validateEventProofs } from "./contract";
import { canonicalRequest, parseActionTarget } from "./attempt";

describe("unlink mutation proof and target closure", () => {
  const pair = actionEventTypes["unlink-social-login"].map((type, index) => ({
    id: `evt_proof${index}`,
    type,
    digest: "a".repeat(64),
  }));
  const third = { id: "evt_disabled", type: "identity.user.auth-method-disabled", digest: "b".repeat(64) };
  it("accepts only the exact unlink pair or ordered conditional third", () => {
    expect(validateEventProofs("unlink-social-login", pair)).toEqual(pair);
    expect(validateEventProofs("unlink-social-login", [...pair, third])).toEqual([...pair, third]);
    for (const events of [
      [],
      [pair[0]],
      [...pair].reverse(),
      [...pair, { ...third, type: "identity.user.suspended" }],
      [...pair, third, third],
      [pair[0], pair[0]],
      [{ ...pair[0], extra: "marker" }, pair[1]],
    ])
      expect(() => validateEventProofs("unlink-social-login", events)).toThrow("INDETERMINATE");
    for (const action of Object.keys(actionEventTypes) as (keyof typeof actionEventTypes)[])
      if (action !== "unlink-social-login")
        expect(() => validateEventProofs(action, [...pair, third])).toThrow("INDETERMINATE");
  });
  it("admits only a hex target and an empty canonical body", () => {
    const key = "c".repeat(64);
    expect(canonicalRequest("unlink-social-login", key, {})).toMatchObject({
      action: "unlink-social-login",
      target: key,
      fields: {},
    });
    for (const target of [null, "C".repeat(64), "c".repeat(63), "usr_test", "g".repeat(64)])
      expect(() => parseActionTarget("unlink-social-login", target)).toThrow();
    for (const name of ["linkKey", "authenticationMethod", "authenticatedAt", "actor"])
      expect(() => canonicalRequest("unlink-social-login", key, { [name]: "marker" })).toThrow();
  });
});
