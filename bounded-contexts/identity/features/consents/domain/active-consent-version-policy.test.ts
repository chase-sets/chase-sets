import { describe, expect, it } from "vitest";
import { publicPolicyKeys, publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import {
  decodeActiveConsentVersionPolicyValue,
  identityActiveConsentVersionPolicies,
} from "./active-consent-version-policy";

describe("active consent version policies", () => {
  it("defines one policy per public document and preserves the Terms policy key", () => {
    expect(Object.keys(identityActiveConsentVersionPolicies)).toEqual(publicPolicyKeys);
    expect(identityActiveConsentVersionPolicies["terms-of-service"].policyKey).toBe(
      "identity.terms-of-service-active-version",
    );

    for (const policyKey of publicPolicyKeys) {
      expect(identityActiveConsentVersionPolicies[policyKey]).toMatchObject({
        policyKey: `identity.${policyKey}-active-version`,
        contextName: "identity",
        defaultValue: { version: publicPolicyPublicationRecords[policyKey].version },
      });
    }
  });

  it("accepts only closed vN version values", () => {
    expect(decodeActiveConsentVersionPolicyValue({ version: "v3" })).toEqual({ version: "v3" });
    expect(() => decodeActiveConsentVersionPolicyValue({ version: "2026-07-24" })).toThrow();
    expect(() => decodeActiveConsentVersionPolicyValue({ version: "v0" })).toThrow();
    expect(() => decodeActiveConsentVersionPolicyValue({ version: "v1", extra: true })).toThrow();
    expect(() => decodeActiveConsentVersionPolicyValue(null)).toThrow();
  });
});
