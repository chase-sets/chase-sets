import type { PublicPolicyKey } from "@chase-sets/public-docs";
import type { ConsentSubjectType } from "../../../support/runtime-support/common";

export const CONSENT_BUNDLE_KEYS = ["registration", "seller-onboarding"] as const;

export type ConsentBundleKey = (typeof CONSENT_BUNDLE_KEYS)[number];
export type ConsentBundleAffirmer = "subject-user" | "authorized-account-member";

/**
 * A Consent Bundle is the ordered set of published policies a person affirms
 * on one product surface. The bundle owns subject scope so every member is
 * recorded consistently even though one affirmation produces distinct,
 * auditable Consent facts.
 */
export type ConsentBundle = Readonly<{
  key: ConsentBundleKey;
  subjectType: ConsentSubjectType;
  affirmedBy: ConsentBundleAffirmer;
  policyKeys: readonly PublicPolicyKey[];
}>;

export const consentBundles = {
  registration: {
    key: "registration",
    subjectType: "user",
    affirmedBy: "subject-user",
    policyKeys: ["terms-of-service", "privacy-policy"],
  },
  "seller-onboarding": {
    key: "seller-onboarding",
    subjectType: "account",
    affirmedBy: "authorized-account-member",
    policyKeys: ["seller-agreement", "payments-terms"],
  },
} as const satisfies Readonly<Record<ConsentBundleKey, ConsentBundle>>;

export function getConsentBundle(key: ConsentBundleKey): ConsentBundle {
  return consentBundles[key];
}
