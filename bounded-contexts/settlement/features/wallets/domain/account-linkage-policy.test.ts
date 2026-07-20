import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE,
  accountLinkageFlagPolicy,
  decodeAccountLinkageFlagPolicyValue,
} from "./account-linkage-policy";

describe("Account Linkage Flag Policy", () => {
  it("declares conservative launch defaults", () => {
    expect(accountLinkageFlagPolicy.policyKey).toBe("settlement.account-linkage-flags");
    expect(accountLinkageFlagPolicy.defaultValue).toEqual(ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE);
  });

  it("decodes threshold and per-signal enablement", () => {
    expect(
      decodeAccountLinkageFlagPolicyValue({
        minimumClusterSize: 3,
        sharedInstrumentEnabled: false,
        sharedAddressEnabled: true,
      }),
    ).toEqual({ minimumClusterSize: 3, sharedInstrumentEnabled: false, sharedAddressEnabled: true });
  });

  it("enforces bounds and complete boolean enablement", () => {
    expect(() =>
      decodeAccountLinkageFlagPolicyValue({
        minimumClusterSize: 1,
        sharedInstrumentEnabled: true,
        sharedAddressEnabled: true,
      }),
    ).toThrow("between 2 and 1000");
    expect(() =>
      decodeAccountLinkageFlagPolicyValue({
        minimumClusterSize: 2,
        sharedInstrumentEnabled: "yes",
        sharedAddressEnabled: true,
      }),
    ).toThrow("booleans");
  });
});
