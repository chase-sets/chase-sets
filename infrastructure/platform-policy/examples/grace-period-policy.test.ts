import { describe, expect, it } from "vitest";
import { decodeGracePeriodPolicyValue, gracePeriodPolicy } from "./grace-period-policy";

describe("grace period example policy", () => {
  it("declares itself under the platform-policy context with a sane compiled default", () => {
    expect(gracePeriodPolicy).toMatchObject({
      policyKey: "platform-policy.example.grace-period",
      contextName: "platform-policy",
      defaultValue: { graceDays: 3 },
    });
  });

  it("decodes a valid value", () => {
    expect(decodeGracePeriodPolicyValue({ graceDays: 14 })).toEqual({ graceDays: 14 });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["an array", []],
    ["a non-integer graceDays", { graceDays: 1.5 }],
    ["a negative graceDays", { graceDays: -1 }],
    ["a graceDays above the cap", { graceDays: 91 }],
  ] as const)("rejects %s", (_label, raw) => {
    expect(() => decodeGracePeriodPolicyValue(raw as never)).toThrow();
  });
});
