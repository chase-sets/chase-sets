import { describe, expect, it } from "vitest";
import { consentBundles } from "./consent-bundle";

describe("Consent Bundles", () => {
  it("defines the settled ordered policy membership and subject scope", () => {
    expect(consentBundles.registration).toEqual({
      key: "registration",
      subjectType: "user",
      affirmedBy: "subject-user",
      policyKeys: ["terms-of-service", "privacy-policy"],
    });
    expect(consentBundles["seller-onboarding"]).toEqual({
      key: "seller-onboarding",
      subjectType: "account",
      affirmedBy: "authorized-account-member",
      policyKeys: ["seller-agreement", "payments-terms"],
    });
  });
});
