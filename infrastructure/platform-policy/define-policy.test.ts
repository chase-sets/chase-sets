import { describe, expect, it } from "vitest";
import { definePolicy, encodePolicyValue, isPolicyKey } from "./define-policy";
import { PlatformPolicyDomainError } from "./domain";

describe("isPolicyKey", () => {
  it("accepts dotted lowercase keys", () => {
    expect(isPolicyKey("settlement.clearance-window")).toBe(true);
    expect(isPolicyKey("platform-operations.support-flow-deadlines")).toBe(true);
  });

  it("rejects keys without a dot or with disallowed characters", () => {
    expect(isPolicyKey("clearanceWindow")).toBe(false);
    expect(isPolicyKey("settlement")).toBe(false);
    expect(isPolicyKey("Settlement.ClearanceWindow")).toBe(false);
    expect(isPolicyKey("settlement..clearance")).toBe(false);
    expect(isPolicyKey("")).toBe(false);
  });
});

describe("encodePolicyValue", () => {
  it("round-trips a plain object through JSON", () => {
    expect(encodePolicyValue({ holdDays: 2, label: "standard" })).toEqual({ holdDays: 2, label: "standard" });
  });

  it("drops keys with undefined values, matching JSON semantics", () => {
    expect(encodePolicyValue({ holdDays: 2, note: undefined })).toEqual({ holdDays: 2 });
  });
});

describe("definePolicy", () => {
  const decodeHoldDays = (raw: unknown) => {
    const value = raw as { holdDays?: unknown };
    if (typeof value.holdDays !== "number") {
      throw new Error("holdDays must be a number.");
    }
    return { holdDays: value.holdDays };
  };

  it("returns a definition carrying the declared metadata", () => {
    const definition = definePolicy({
      policyKey: "settlement.clearance-window",
      contextName: "settlement",
      schemaSummary: "{ holdDays: integer }",
      defaultValue: { holdDays: 2 },
      decodeValue: decodeHoldDays,
    });

    expect(definition).toMatchObject({
      policyKey: "settlement.clearance-window",
      contextName: "settlement",
      schemaSummary: "{ holdDays: integer }",
      defaultValue: { holdDays: 2 },
    });
  });

  it("rejects a malformed policy key at declaration time", () => {
    expect(() =>
      definePolicy({
        policyKey: "clearanceWindow",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        defaultValue: { holdDays: 2 },
        decodeValue: decodeHoldDays,
      }),
    ).toThrow(PlatformPolicyDomainError);
  });

  it("rejects a default value that its own decodeValue cannot decode", () => {
    expect(() =>
      definePolicy({
        policyKey: "settlement.clearance-window",
        contextName: "settlement",
        schemaSummary: "{ holdDays: integer }",
        defaultValue: { holdDays: "two" } as never,
        decodeValue: decodeHoldDays,
      }),
    ).toThrow("holdDays must be a number.");
  });
});
