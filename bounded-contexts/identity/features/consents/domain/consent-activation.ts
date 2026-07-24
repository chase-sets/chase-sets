import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  publicPolicyPublicationRecords,
  type PublicPolicyKey,
  type PublicPolicyPublicationRecord,
  type PublicPolicyVersion,
} from "@chase-sets/public-docs";
import { IdentityDomainError } from "../../../support/runtime-support/common";
import {
  identityActiveConsentVersionPolicies,
  type ActiveConsentVersionPolicyValue,
} from "./active-consent-version-policy";
import { getConsentBundle, type ConsentBundleKey } from "./consent-bundle";

export type ConsentPublicationRegistry = Readonly<Record<PublicPolicyKey, PublicPolicyPublicationRecord>>;

export type ActivatedConsentPolicy = Readonly<{
  policyKey: PublicPolicyKey;
  version: PublicPolicyVersion;
}>;

export async function resolveActivatedConsentPolicy(
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  policyKey: PublicPolicyKey,
  publications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<ActivatedConsentPolicy | null> {
  const publication = publications[policyKey];
  if (publication.publicationStatus !== "published" || !publication.consentActivatable) {
    return null;
  }

  const resolved = await policies.resolvePolicy<ActiveConsentVersionPolicyValue>(
    identityActiveConsentVersionPolicies[policyKey],
  );
  if (resolved.source !== "policy" || resolved.value.version !== publication.version) {
    return null;
  }

  return {
    policyKey,
    version: publication.version,
  };
}

export async function resolveConsentBundleRequirements(
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  bundleKey: ConsentBundleKey,
  publications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<readonly ActivatedConsentPolicy[]> {
  const bundle = getConsentBundle(bundleKey);
  const resolved = await Promise.all(
    bundle.policyKeys.map((policyKey) => resolveActivatedConsentPolicy(policies, policyKey, publications)),
  );

  return resolved.filter((requirement): requirement is ActivatedConsentPolicy => requirement !== null);
}

export async function assertConsentAcceptanceIsActivated(
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  acceptance: ActivatedConsentPolicy,
  publications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<void> {
  const activated = await resolveActivatedConsentPolicy(policies, acceptance.policyKey, publications);
  if (!activated || activated.version !== acceptance.version) {
    throw new IdentityDomainError(
      `Consent acceptance for '${acceptance.policyKey}' version '${acceptance.version}' is not published and activated.`,
    );
  }
}
