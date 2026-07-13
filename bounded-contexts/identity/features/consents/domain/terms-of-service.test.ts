import { describe, expect, it } from "vitest";
import {
  isCanonicalTermsOfServiceConsentPolicyKey,
  isRecognizedTermsOfServiceConsentPolicyKey,
  isValidTermsOfServiceConsentVersion,
  TERMS_OF_SERVICE_CONSENT_POLICY_KEY,
} from "./terms-of-service";

describe("terms of service consent canonicalization", () => {
  it("selects terms-of-service as the canonical policy key", () => {
    expect(TERMS_OF_SERVICE_CONSENT_POLICY_KEY).toBe("terms-of-service");
    expect(isCanonicalTermsOfServiceConsentPolicyKey("terms-of-service")).toBe(true);
    expect(isCanonicalTermsOfServiceConsentPolicyKey("terms")).toBe(false);
  });

  it("recognizes the legacy 'terms' alias for read/history purposes only", () => {
    expect(isRecognizedTermsOfServiceConsentPolicyKey("terms-of-service")).toBe(true);
    expect(isRecognizedTermsOfServiceConsentPolicyKey("terms")).toBe(true);
    expect(isRecognizedTermsOfServiceConsentPolicyKey("privacy-policy")).toBe(false);
  });

  it("validates the canonical vN version format", () => {
    expect(isValidTermsOfServiceConsentVersion("v1")).toBe(true);
    expect(isValidTermsOfServiceConsentVersion("v2")).toBe(true);
    expect(isValidTermsOfServiceConsentVersion("v10")).toBe(true);
    expect(isValidTermsOfServiceConsentVersion("v0")).toBe(false);
    expect(isValidTermsOfServiceConsentVersion("2026-06-15")).toBe(false);
    expect(isValidTermsOfServiceConsentVersion("")).toBe(false);
  });
});
