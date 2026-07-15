import { describe, expect, it } from "vitest";
import {
  assertRemedyPolicyLimit,
  decodePlatformRemedyPolicyValue,
  PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
  platformRemedyPolicy,
  strongestRemedyPolicyAuthority,
} from "./platform-remedy-policy";

describe("platform remedy policy", () => {
  it("owns every configurable policy dimension with a versioned policy key", () => {
    expect(platformRemedyPolicy.policyKey).toBe("platform-operations.platform-remedies");
    expect(decodePlatformRemedyPolicyValue(PLATFORM_REMEDY_LAUNCH_POLICY_VALUE as never)).toEqual(
      PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
    );
  });

  it("resolves the strongest granted authority and enforces amount limits server-side", () => {
    expect(strongestRemedyPolicyAuthority(["support.remedies.propose", "support.remedies.approve-elevated"])).toBe(
      "approveElevated",
    );
    expect(() =>
      assertRemedyPolicyLimit({
        authority: "approve",
        amount: "250.01",
        eligibleAmount: "500.00",
        policy: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
      }),
    ).toThrow("exceeds the approve amount limit");
  });

  it("rejects unknown triggers and incomplete exception configuration", () => {
    expect(() =>
      decodePlatformRemedyPolicyValue({
        ...PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
        allowableRefundTriggers: ["provider-decides"],
      } as never),
    ).toThrow("unknown trigger");
  });
});
