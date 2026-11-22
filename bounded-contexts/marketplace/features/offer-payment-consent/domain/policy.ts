import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import {
  isOfferPaymentConsentVersion,
  OFFER_AUTOMATIC_CHARGE_V1,
  OFFER_PAYMENT_CONSENT_POLICY_KEY,
  type OfferPaymentConsentPublications,
} from "./consent-text";

export const marketplaceOfferPaymentConsentPolicy = definePolicy<Readonly<{ approvedConsentVersion: string | null }>>({
  policyKey: OFFER_PAYMENT_CONSENT_POLICY_KEY,
  contextName: "marketplace",
  schemaSummary: "{ approvedConsentVersion: null or an offer-automatic-charge-v<N> version }",
  defaultValue: { approvedConsentVersion: null },
  decodeValue(raw) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 1 ||
      !("approvedConsentVersion" in raw) ||
      (raw.approvedConsentVersion !== null && !isOfferPaymentConsentVersion(raw.approvedConsentVersion))
    ) {
      throw new Error("Expected an Offer payment consent policy with one approvedConsentVersion field.");
    }
    return { approvedConsentVersion: raw.approvedConsentVersion };
  },
});

export function offerPaymentConsentActivationPolicy(
  publications: OfferPaymentConsentPublications,
): PolicyDefinition<Readonly<{ version: string }>> {
  return {
    ...marketplaceOfferPaymentConsentPolicy,
    defaultValue: { version: OFFER_AUTOMATIC_CHARGE_V1 },
    decodeValue(raw) {
      const { approvedConsentVersion: version } = marketplaceOfferPaymentConsentPolicy.decodeValue(raw);
      if (version === null || publications[version]?.version !== version) {
        throw new Error("The policy document must name a declared Offer payment consent version.");
      }
      return { version };
    },
  };
}
