import { describe, expect, it } from "vitest";
import { publicPolicyPublicationRecords, publicTermsOfServicePublicationMetadata } from "@chase-sets/public-docs";
import {
  decodeConsentActiveVersionPolicyValue,
  identityConsentActiveVersionPolicies,
  identityTermsOfServicePolicy,
  IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE,
} from "./terms-of-service-policy";

describe("identity terms of service policy", () => {
  it("declares a dotted policy key distinct from the consent policy key", () => {
    expect(identityTermsOfServicePolicy.policyKey).toBe("identity.terms-of-service-active-version");
    expect(identityTermsOfServicePolicy.contextName).toBe("identity");
  });

  it("defaults to a valid placeholder version pending publication", () => {
    expect(identityTermsOfServicePolicy.defaultValue).toEqual(IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE);
    expect(() =>
      decodeConsentActiveVersionPolicyValue({ version: IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE.version }),
    ).not.toThrow();
    expect(IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE.version).toBe(
      publicTermsOfServicePublicationMetadata.version,
    );
  });

  it("decodes a well-formed value", () => {
    expect(decodeConsentActiveVersionPolicyValue({ version: "v3" })).toEqual({ version: "v3" });
  });

  it("rejects a malformed version", () => {
    expect(() => decodeConsentActiveVersionPolicyValue({ version: "2026-06-15" })).toThrow();
    expect(() => decodeConsentActiveVersionPolicyValue({ version: "" })).toThrow();
    expect(() => decodeConsentActiveVersionPolicyValue({})).toThrow();
  });

  it("rejects a value carrying an unknown member", () => {
    expect(() => decodeConsentActiveVersionPolicyValue({ version: "v1", effectiveAt: "2026-01-01" })).toThrow();
  });

  it("rejects a non-object value", () => {
    expect(() => decodeConsentActiveVersionPolicyValue("v1" as never)).toThrow();
    expect(() => decodeConsentActiveVersionPolicyValue(null)).toThrow();
    expect(() => decodeConsentActiveVersionPolicyValue(["v1"] as never)).toThrow();
  });
});

describe("identity consent active-version policy registry", () => {
  it("declares one policy per consent-bundle member, keyed off its publication key", () => {
    expect(Object.keys(identityConsentActiveVersionPolicies)).toEqual([
      "terms-of-service",
      "privacy-policy",
      "seller-agreement",
      "payments-terms",
    ]);
  });

  it.each(Object.entries(identityConsentActiveVersionPolicies))(
    "derives '%s' into a dotted identity policy key defaulting to its published version",
    (publicPolicyKey, definition) => {
      expect(definition.policyKey).toBe(`identity.${publicPolicyKey}-active-version`);
      expect(definition.contextName).toBe("identity");
      expect(definition.defaultValue).toEqual({
        version: publicPolicyPublicationRecords[publicPolicyKey as "terms-of-service"].version,
      });
    },
  );

  it("keeps the shipped Terms of Service key exactly where it was", () => {
    expect(identityConsentActiveVersionPolicies["terms-of-service"].policyKey).toBe(
      "identity.terms-of-service-active-version",
    );
  });
});
