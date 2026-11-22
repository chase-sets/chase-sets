import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { marketplaceEnglishTranslations } from "@chase-sets/localization/locales/en/marketplace";
import { OFFER_AUTOMATIC_CHARGE_V1, offerPaymentConsentPublications } from "./consent-text";

it("publishes the exact English copy's fingerprint without approving it for activation", () => {
  const copy = marketplaceEnglishTranslations["marketplace.offerPaymentConsent.automaticChargeV1"];
  expect(offerPaymentConsentPublications[OFFER_AUTOMATIC_CHARGE_V1]).toEqual({
    policyKey: "marketplace.offer-payment-consent",
    version: "offer-automatic-charge-v1",
    contentFingerprint: `sha256:${createHash("sha256").update(copy, "utf8").digest("hex")}`,
    counselApprovalReference: null,
    consentActivatable: false,
  });
});
