import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { OFFER_PAYMENT_CONSENT_POLICY_KEY, offerPaymentConsentPublications } from "../domain/consent-text";

export async function resolveOfferPaymentEnforcement(
  consentActivation: Pick<PolicyRuntime["consentActivation"], "read">,
) {
  const snapshot = await consentActivation.read(OFFER_PAYMENT_CONSENT_POLICY_KEY);
  const activeVersion = snapshot.activeVersion;
  return {
    version:
      snapshot.isActive &&
      activeVersion !== null &&
      offerPaymentConsentPublications[activeVersion]?.version === activeVersion
        ? activeVersion
        : null,
    snapshot,
  };
}
