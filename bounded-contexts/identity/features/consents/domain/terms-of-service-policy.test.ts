import { describe, expect, it } from "vitest";
import { publicPolicyPublicationRecords, publicTermsOfServicePublicationMetadata } from "@chase-sets/public-docs";
import {
  decodeConsentPolicyVersionValue,
  decodeTermsOfServicePolicyValue,
  IDENTITY_CONSENT_POLICY_KEYS,
  IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE,
  identityConsentActiveVersionPolicies,
  identityConsentActiveVersionPolicyFor,
  identityTermsOfServicePolicy,
  isIdentityConsentPolicyKey,
  type IdentityConsentPolicyKey,
} from "./terms-of-service-policy";

describe("identity terms of service policy", () => {
  it("declares a dotted policy key distinct from the consent policy key", () => {
    expect(identityTermsOfServicePolicy.policyKey).toBe("identity.terms-of-service-active-version");
    expect(identityTermsOfServicePolicy.contextName).toBe("identity");
  });

  it("defaults to a valid placeholder version pending publication", () => {
    expect(identityTermsOfServicePolicy.defaultValue).toEqual(IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE);
    expect(() =>
      decodeTermsOfServicePolicyValue({ version: IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE.version }),
    ).not.toThrow();
    expect(IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE.version).toBe(
      publicTermsOfServicePublicationMetadata.version,
    );
  });

  it("decodes a well-formed value", () => {
    expect(decodeTermsOfServicePolicyValue({ version: "v3" })).toEqual({ version: "v3" });
  });

  it("rejects a malformed version", () => {
    expect(() => decodeTermsOfServicePolicyValue({ version: "2026-06-15" })).toThrow();
    expect(() => decodeTermsOfServicePolicyValue({ version: "" })).toThrow();
    expect(() => decodeTermsOfServicePolicyValue({})).toThrow();
  });

  it("rejects a non-object value", () => {
    expect(() => decodeTermsOfServicePolicyValue("v1" as never)).toThrow();
    expect(() => decodeTermsOfServicePolicyValue(null)).toThrow();
    expect(() => decodeTermsOfServicePolicyValue(["v1"] as never)).toThrow();
  });
});

describe("identity consent active-version policy registry", () => {
  it("is closed over exactly the four consent policy keys", () => {
    expect(IDENTITY_CONSENT_POLICY_KEYS).toEqual([
      "terms-of-service",
      "privacy-policy",
      "seller-agreement",
      "payments-terms",
    ]);
    expect(Object.keys(identityConsentActiveVersionPolicies).sort()).toEqual([
      "payments-terms",
      "privacy-policy",
      "seller-agreement",
      "terms-of-service",
    ]);
  });

  it.each([
    { policyKey: "terms-of-service" as const, activeVersionPolicyKey: "identity.terms-of-service-active-version" },
    { policyKey: "privacy-policy" as const, activeVersionPolicyKey: "identity.privacy-policy-active-version" },
    { policyKey: "seller-agreement" as const, activeVersionPolicyKey: "identity.seller-agreement-active-version" },
    { policyKey: "payments-terms" as const, activeVersionPolicyKey: "identity.payments-terms-active-version" },
  ])("maps $policyKey to $activeVersionPolicyKey", ({ policyKey, activeVersionPolicyKey }) => {
    const definition = identityConsentActiveVersionPolicyFor(policyKey);

    expect(definition.policyKey).toBe(activeVersionPolicyKey);
    expect(definition.contextName).toBe("identity");
    expect(definition.schemaSummary).toBe("{ version: string matching /^v[1-9][0-9]*$/ }");
  });

  it("preserves the Terms of Service active-version key exactly", () => {
    // Operator-created platform-policy documents already reference this key.
    // Renaming it would orphan them, so the literal is asserted here as well as
    // in the mapping table above.
    expect(identityConsentActiveVersionPolicyFor("terms-of-service").policyKey).toBe(
      "identity.terms-of-service-active-version",
    );
  });

  it.each(IDENTITY_CONSENT_POLICY_KEYS)(
    "decodes %s's declared default value",
    (policyKey: IdentityConsentPolicyKey) => {
      const definition = identityConsentActiveVersionPolicies[policyKey];

      expect(() => decodeConsentPolicyVersionValue({ ...definition.defaultValue })).not.toThrow();
      // The placeholder tracks the compiled publication record and nothing else.
      expect(definition.defaultValue.version).toBe(publicPolicyPublicationRecords[policyKey].version);
    },
  );

  it.each(IDENTITY_CONSENT_POLICY_KEYS)(
    "keeps %s's placeholder default from creating a requirement, because the publication is not activatable",
    (policyKey: IdentityConsentPolicyKey) => {
      // The default is a decodable value, and the corresponding publication is
      // not consent-activatable. A default is therefore never an activation.
      expect(publicPolicyPublicationRecords[policyKey].consentActivatable).toBe(false);
      expect(identityConsentActiveVersionPolicies[policyKey].defaultValue.version).toBe(
        publicPolicyPublicationRecords[policyKey].version,
      );
    },
  );

  it.each(["terms", "identity.terms-of-service-active-version", "seller_agreement", "", "TERMS-OF-SERVICE"])(
    "rejects the unknown consent policy key %j",
    (policyKey: string) => {
      expect(isIdentityConsentPolicyKey(policyKey)).toBe(false);
      expect(() => identityConsentActiveVersionPolicyFor(policyKey)).toThrow(
        /not a recognized Identity consent policy/,
      );
    },
  );

  it.each([
    { name: "a non-object", value: "v1" },
    { name: "null", value: null },
    { name: "an array", value: ["v1"] },
    { name: "a date-shaped version", value: { version: "2026-06-15" } },
    { name: "an empty version", value: { version: "" } },
    { name: "a whitespace version", value: { version: "   " } },
    { name: "a zero version", value: { version: "v0" } },
    { name: "a missing version", value: {} },
    { name: "a non-string version", value: { version: 1 } },
    { name: "an unknown extra field", value: { version: "v1", locale: "en" } },
  ])("rejects $name as a consent active-version value", ({ value }) => {
    expect(() => decodeConsentPolicyVersionValue(value as never)).toThrow();
  });

  it("accepts and normalizes a padded canonical version", () => {
    expect(decodeConsentPolicyVersionValue({ version: " v12 " })).toEqual({ version: "v12" });
  });
});
