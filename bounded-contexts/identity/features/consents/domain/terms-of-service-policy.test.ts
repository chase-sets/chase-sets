import { describe, expect, it } from "vitest";
import {
  decodeTermsOfServicePolicyValue,
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
      decodeTermsOfServicePolicyValue({ version: IDENTITY_TERMS_OF_SERVICE_PLACEHOLDER_POLICY_VALUE.version }),
    ).not.toThrow();
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
