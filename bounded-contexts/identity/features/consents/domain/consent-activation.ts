import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  publicPolicyPublicationRecords,
  publicPolicyKeys,
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
  href: string;
}>;

export type RegistrationConsentBundleSnapshot = Readonly<{
  bundleKey: "registration";
  requirements: readonly ActivatedConsentPolicy[];
}>;

export type RegistrationConsentSubmission = Readonly<{
  operationId: string;
  snapshot: RegistrationConsentBundleSnapshot;
  affirmed: boolean;
}>;

export type ConsentPolicyStreamGuard = Readonly<{
  streamId: string;
  version: number;
}>;

export type GuardedRegistrationConsentSnapshot = Readonly<{
  snapshot: RegistrationConsentBundleSnapshot;
  policyStreamGuards: readonly ConsentPolicyStreamGuard[];
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
    href: publication.href,
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

export async function resolveGuardedRegistrationConsentSnapshot(
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  eventStore: Pick<EventStore, "readStream">,
  publications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<GuardedRegistrationConsentSnapshot> {
  const bundle = getConsentBundle("registration");
  const resolved = await Promise.all(
    bundle.policyKeys.map(async (policyKey) => {
      const publication = publications[policyKey];
      if (publication.publicationStatus !== "published" || !publication.consentActivatable) {
        return null;
      }

      const policy = await policies.resolvePolicy<ActiveConsentVersionPolicyValue>(
        identityActiveConsentVersionPolicies[policyKey],
      );
      if (policy.source !== "policy" || !policy.documentId || policy.value.version !== publication.version) {
        return null;
      }

      const streamId = `platform-policy.document-${policy.documentId}`;
      const events = await eventStore.readStream({ streamId });
      if (events.length === 0) {
        throw new IdentityDomainError(`Active consent policy '${policyKey}' has no authoritative event stream.`);
      }

      return {
        requirement: {
          policyKey,
          version: publication.version,
          href: publication.href,
        } satisfies ActivatedConsentPolicy,
        guard: {
          streamId,
          version: events[events.length - 1]!.streamVersion,
        } satisfies ConsentPolicyStreamGuard,
      };
    }),
  );
  const active = resolved.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    snapshot: {
      bundleKey: "registration",
      requirements: active.map((entry) => entry.requirement),
    },
    policyStreamGuards: active.map((entry) => entry.guard),
  };
}

export function registrationConsentSnapshotsMatch(
  left: RegistrationConsentBundleSnapshot,
  right: RegistrationConsentBundleSnapshot,
) {
  return (
    left.bundleKey === right.bundleKey &&
    left.requirements.length === right.requirements.length &&
    left.requirements.every((requirement, index) => {
      const candidate = right.requirements[index];
      return (
        candidate?.policyKey === requirement.policyKey &&
        candidate.version === requirement.version &&
        candidate.href === requirement.href
      );
    })
  );
}

export function parseRegistrationConsentSubmission(value: unknown): RegistrationConsentSubmission {
  if (!value || typeof value !== "object") {
    throw new IdentityDomainError("Registration consent submission is required.");
  }
  const submission = value as Record<string, unknown>;
  const snapshot = submission.snapshot;
  if (
    typeof submission.operationId !== "string" ||
    !snapshot ||
    typeof snapshot !== "object" ||
    (snapshot as Record<string, unknown>).bundleKey !== "registration" ||
    !Array.isArray((snapshot as Record<string, unknown>).requirements)
  ) {
    throw new IdentityDomainError("Registration consent submission is invalid.");
  }
  const requirements = (snapshot as Record<string, unknown>).requirements as unknown[];
  const parsedRequirements = requirements.map((requirement) => {
    if (!requirement || typeof requirement !== "object") {
      throw new IdentityDomainError("Registration consent requirement is invalid.");
    }
    const record = requirement as Record<string, unknown>;
    if (
      typeof record.policyKey !== "string" ||
      !publicPolicyKeys.includes(record.policyKey as PublicPolicyKey) ||
      typeof record.version !== "string" ||
      typeof record.href !== "string"
    ) {
      throw new IdentityDomainError("Registration consent requirement is invalid.");
    }
    return {
      policyKey: record.policyKey as PublicPolicyKey,
      version: record.version as PublicPolicyVersion,
      href: record.href,
    };
  });

  return {
    operationId: submission.operationId,
    snapshot: {
      bundleKey: "registration",
      requirements: parsedRequirements,
    },
    affirmed: submission.affirmed === true,
  };
}

export async function assertConsentAcceptanceIsActivated(
  policies: Pick<PolicyRuntime, "resolvePolicy">,
  acceptance: Pick<ActivatedConsentPolicy, "policyKey" | "version">,
  publications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<void> {
  const activated = await resolveActivatedConsentPolicy(policies, acceptance.policyKey, publications);
  if (!activated || activated.version !== acceptance.version) {
    throw new IdentityDomainError(
      `Consent acceptance for '${acceptance.policyKey}' version '${acceptance.version}' is not published and activated.`,
    );
  }
}
