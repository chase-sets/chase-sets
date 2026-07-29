import type { EventStore } from "@chase-sets/event-core/event-store";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
import {
  assessConsentRecordingPublication,
  consentBundleMemberActivationPolicyKey,
} from "../../features/consents/domain/consent-bundle";
import { isIdentityConsentPolicyKey } from "../../features/consents/domain/terms-of-service-policy";

/**
 * Whether a seeded, bootstrapped, or fixture-provisioned Consent recording is
 * admissible right now -- consulted by every non-request path that records
 * Consent directly, so none of them carries its own copy of the rule.
 *
 * These paths ABSTAIN rather than fail when a document is not yet
 * consent-activatable or not yet activated. A demo scenario, a representative
 * account, and an admin-QA actor are all fixtures; none of them is a person who
 * agreed to anything, so provisioning one must never manufacture an acceptance
 * of a policy the platform has not published and activated. Abstaining is the
 * correct outcome for the shipped corpus, and it becomes recording the moment
 * both halves of the invariant hold -- without any of these call sites changing.
 *
 * Whether these fixtures ultimately owe bundle consent at all is a separate,
 * open decision owned by the consent-bundle decision issue linked from the
 * originating consent-bundle issue; this module decides only that they never
 * write an inadmissible one.
 */
export type SeededConsentAdmission =
  | Readonly<{ admitted: true; version: string }>
  | Readonly<{ admitted: false; reason: string }>;

export async function resolveSeededConsentAdmission(
  eventStore: EventStore,
  policyKey: string,
  policyVersion: string,
): Promise<SeededConsentAdmission> {
  const publication = assessConsentRecordingPublication(policyKey, policyVersion);
  if (!publication.admitted) {
    return { admitted: false, reason: `${publication.code}: ${publication.message}` };
  }
  if (!isIdentityConsentPolicyKey(policyKey)) {
    return {
      admitted: false,
      reason: `consent_policy_not_bundle_member: '${policyKey}' declares no activation authority.`,
    };
  }

  const activationPolicyKey = consentBundleMemberActivationPolicyKey(policyKey);
  const snapshot = await readConsentActivationAuthority(eventStore, activationPolicyKey);
  if (!snapshot.isActive) {
    return {
      admitted: false,
      reason: `consent_policy_not_activated: the Consent Activation Authority for '${activationPolicyKey}' is ${snapshot.status}.`,
    };
  }
  if (snapshot.activeVersion !== policyVersion) {
    return {
      admitted: false,
      reason: `consent_policy_activation_version_mismatch: '${activationPolicyKey}' is active at '${String(snapshot.activeVersion)}', not '${policyVersion}'.`,
    };
  }

  return { admitted: true, version: policyVersion };
}

/** One explicit line per abstention, so a skipped seeded Consent is never silent. */
export function reportSeededConsentAbstention(label: string, admission: SeededConsentAdmission): void {
  if (admission.admitted) {
    return;
  }
  console.log(`Identity seed abstained from recording Consent for ${label}: ${admission.reason}`);
}

/** The event store a seeded Consent admission needs, or an explicit failure. */
export function requireSeedEventStore(eventStore: EventStore | undefined): EventStore {
  if (!eventStore) {
    throw new Error("Seeding Consent requires Identity services composed with an event store.");
  }
  return eventStore;
}
