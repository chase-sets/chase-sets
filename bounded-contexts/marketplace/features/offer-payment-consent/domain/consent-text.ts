import { createHash } from "node:crypto";
import { marketplaceEnglishTranslations } from "@chase-sets/localization/locales/en/marketplace";

export const OFFER_PAYMENT_CONSENT_POLICY_KEY = "marketplace.offer-payment-consent";
export const OFFER_AUTOMATIC_CHARGE_V1 = "offer-automatic-charge-v1";

export function isOfferPaymentConsentVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^offer-automatic-charge-v[1-9][0-9]*$/.test(value);
}

export type OfferPaymentConsentPublication = Readonly<{
  policyKey: string;
  version: string;
  contentFingerprint: string;
  counselApprovalReference: string | null;
  consentActivatable: boolean;
}>;

export type OfferPaymentConsentPublications = Readonly<Record<string, OfferPaymentConsentPublication | undefined>>;

const automaticChargeV1: Readonly<{
  englishCopy: string;
  counselApproval: Readonly<{ reference: string; contentFingerprint: string }> | null;
}> = {
  englishCopy: marketplaceEnglishTranslations["marketplace.offerPaymentConsent.automaticChargeV1"],
  counselApproval: null,
};

const contentFingerprint = `sha256:${createHash("sha256").update(automaticChargeV1.englishCopy).digest("hex")}`;
const counselApprovalReference =
  automaticChargeV1.counselApproval?.contentFingerprint === contentFingerprint
    ? automaticChargeV1.counselApproval.reference
    : null;

export const offerPaymentConsentPublications: OfferPaymentConsentPublications = {
  [OFFER_AUTOMATIC_CHARGE_V1]: {
    policyKey: OFFER_PAYMENT_CONSENT_POLICY_KEY,
    version: OFFER_AUTOMATIC_CHARGE_V1,
    contentFingerprint,
    counselApprovalReference,
    consentActivatable: counselApprovalReference !== null,
  },
};
