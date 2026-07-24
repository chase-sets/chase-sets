import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PublicPolicyKey, PublicPolicyVersion } from "@chase-sets/public-docs";
import type { ConsentSubjectType } from "../../../support/runtime-support/common";
import { identityActiveConsentVersionPolicies } from "../domain/active-consent-version-policy";
import { resolveConsentBundleRequirements, type ConsentPublicationRegistry } from "../domain/consent-activation";
import { getConsentBundle, type ConsentBundleKey } from "../domain/consent-bundle";
import { findCurrentConsent } from "./queries";

export type ConsentAcceptanceSubject = Readonly<{
  subjectType?: ConsentSubjectType;
  userId?: string | null;
  accountId?: string | null;
}>;

export type PolicyAcceptanceStatus = Readonly<{
  policyKey: PublicPolicyKey;
  requiredVersion: PublicPolicyVersion;
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}>;

export type ConsentBundleAcceptanceStatus = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: ConsentSubjectType;
  accepted: boolean;
  policies: readonly PolicyAcceptanceStatus[];
}>;

export async function resolvePolicyAcceptanceStatus(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  params: Readonly<{
    policyKey: PublicPolicyKey;
    subject: ConsentAcceptanceSubject;
    requiredVersion?: PublicPolicyVersion;
  }>,
): Promise<PolicyAcceptanceStatus> {
  const requiredVersion =
    params.requiredVersion ??
    (await policies.resolvePolicy(identityActiveConsentVersionPolicies[params.policyKey])).value.version;
  const current = await findCurrentConsent(db, {
    subjectType: params.subject.subjectType,
    userId: params.subject.subjectType === "account" ? null : (params.subject.userId ?? null),
    accountId: params.subject.subjectType === "user" ? null : (params.subject.accountId ?? null),
    policyKey: params.policyKey,
  });

  return {
    policyKey: params.policyKey,
    requiredVersion,
    accepted:
      current?.status === "recorded" &&
      (!params.subject.subjectType || current.subject_type === params.subject.subjectType) &&
      current.policy_key === params.policyKey &&
      current.policy_version === requiredVersion,
    acceptedVersion: current?.policy_version ?? null,
    acceptedAt: current?.recorded_at ?? null,
  };
}

export async function resolveConsentBundleAcceptanceStatus(
  db: PgQueryable,
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  bundleKey: ConsentBundleKey,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
  publications?: ConsentPublicationRegistry,
): Promise<ConsentBundleAcceptanceStatus> {
  const bundle = getConsentBundle(bundleKey);
  const requirements = await resolveConsentBundleRequirements(policies, bundleKey, publications);
  const scopedSubject: ConsentAcceptanceSubject = {
    subjectType: bundle.subjectType,
    userId: subject.userId,
    accountId: subject.accountId,
  };
  const statuses = await Promise.all(
    requirements.map((requirement) =>
      resolvePolicyAcceptanceStatus(db, policies, {
        policyKey: requirement.policyKey,
        requiredVersion: requirement.version,
        subject: scopedSubject,
      }),
    ),
  );

  return {
    bundleKey,
    subjectType: bundle.subjectType,
    accepted: statuses.every((status) => status.accepted),
    policies: statuses,
  };
}
