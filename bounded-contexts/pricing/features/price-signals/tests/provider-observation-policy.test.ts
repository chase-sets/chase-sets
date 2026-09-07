import { describe, expect, it } from "vitest";
import {
  decodeProviderObservationPolicyValue,
  PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
  providerObservationPolicy,
} from "../domain/provider-observation-policy";

describe("pricing.provider-observation policy", () => {
  it("keeps capturesPerPass inside the post-signal authority", () => {
    expect(providerObservationPolicy.policyKey).toBe("pricing.provider-observation");
    expect(decodeProviderObservationPolicyValue(PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE as never)).toEqual(
      PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
    );
  });

  it.each([undefined, null, 0, -1, 1.5, 6, "1"])("rejects invalid capturesPerPass %j", (value) => {
    expect(() =>
      decodeProviderObservationPolicyValue({
        ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
        capturesPerPass: value,
      } as never),
    ).toThrow();
  });

  it("recursively closes nested objects and refuses malformed money", () => {
    expect(() =>
      decodeProviderObservationPolicyValue({
        ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
        listings: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings, sellerKey: "secret" },
      } as never),
    ).toThrow();
    expect(() =>
      decodeProviderObservationPolicyValue({
        ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
        freeShippingThreshold: "5.001",
      } as never),
    ).toThrow();
  });
});
