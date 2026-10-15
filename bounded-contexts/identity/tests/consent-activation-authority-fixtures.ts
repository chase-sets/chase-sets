import {
  consentActivationAuthorityStreamId,
  decodeConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationAuthoritySnapshot,
} from "@chase-sets/platform-policy/consent-activation-authority";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  assertRegistrationConsentDeclaration,
  bindRegistrationConsentSubject,
  identityConsentPolicyPublications,
  resolveConsentBundleAgainstCorpus,
  type ConsentActivationAuthorityReader,
  type ConsentPolicyPublicationCorpus,
  type RegistrationConsentBundles,
} from "../features/consents/domain/consent-bundle";
import {
  identityConsentActiveVersionPolicies,
  type IdentityConsentPolicyKey,
} from "../features/consents/domain/terms-of-service-policy";
import { createIdentityBootstrapContext } from "../support/runtime-support/bootstrap-context";

export function registrationConsentBundlesFixture(
  authority: ConsentActivationAuthorityReader = {
    read: async () => {
      throw new Error("Dormant publications must not read authority.");
    },
  },
  publications: ConsentPolicyPublicationCorpus = identityConsentPolicyPublications,
): RegistrationConsentBundles {
  const bundles: RegistrationConsentBundles = {
    async resolve() {
      const declaration = await resolveConsentBundleAgainstCorpus(authority, "registration", publications);
      assertRegistrationConsentDeclaration(declaration);
      return declaration;
    },
    async forRegistration(subject) {
      return bindRegistrationConsentSubject(await bundles.resolve(), subject);
    },
  };
  return bundles;
}

export async function activeRegistrationConsentFixture(
  eventStore: EventStore,
  db: PgQueryable,
  versions: Partial<Record<IdentityConsentPolicyKey, `v${number}`>>,
) {
  const policies = createPolicyRuntime({ eventStore, db });
  const publications = { ...identityConsentPolicyPublications } as Record<
    IdentityConsentPolicyKey,
    ConsentPolicyPublicationCorpus[IdentityConsentPolicyKey]
  >;
  const context = createIdentityBootstrapContext();
  for (const policyKey of Object.keys(versions) as IdentityConsentPolicyKey[]) {
    const version = versions[policyKey]!;
    publications[policyKey] = {
      ...publications[policyKey],
      version,
      publicationStatus: "published",
      consentActivatable: true,
    };
    const definition = identityConsentActiveVersionPolicies[policyKey];
    await policies.consentActivation.register(definition, context);
    await policies.consentActivation.activate(
      definition,
      {
        version,
        documentId: `pol_test_${policyKey}`,
        actorUserId: "usr_test_operator",
      },
      context,
    );
  }
  return {
    policies,
    publications,
    registrationConsentBundles: registrationConsentBundlesFixture(policies.consentActivation, publications),
  };
}

/**
 * Validated Consent Activation Authority snapshots for Identity's consent
 * tests.
 *
 * Every fixture here is minted by the owning context's canonical snapshot
 * decoder, never hand-assembled. That is the point: Identity consumes the
 * validated authority contract rather than duplicating its validation, so a
 * fixture that describes an impossible lifecycle fails at construction time in
 * the test file instead of quietly exercising a state production can never
 * reach.
 */

const LAST_TRANSITION_AT = "2026-07-01T00:00:00.000Z";

export function neverActivatedUnregisteredSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: false,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: null,
    authorityVersion: 0,
    guard: { policyKey, streamId, expectedVersion: "no_stream" },
  });
}

export function registeredNeverActivatedSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 1,
    guard: { policyKey, streamId, expectedVersion: 1 },
  });
}

export function activeSnapshot(policyKey: string, version: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol_active",
    activationCount: 1,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 2,
    guard: { policyKey, streamId, expectedVersion: 2 },
  });
}

export function deactivatedSnapshot(policyKey: string): ValidatedConsentActivationAuthoritySnapshot {
  const streamId = consentActivationAuthorityStreamId(policyKey);
  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: true,
    status: "inactive",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 1,
    lastTransitionAt: LAST_TRANSITION_AT,
    authorityVersion: 3,
    guard: { policyKey, streamId, expectedVersion: 3 },
  });
}

export type RecordingAuthorityReader = ConsentActivationAuthorityReader &
  Readonly<{
    /** Every policy key this reader was asked for, in call order. */
    reads: readonly string[];
  }>;

/**
 * An authority reader backed by an explicit per-policy-key script, recording
 * exactly which authorities were read. The read trace is how "no authority read
 * was performed" is asserted positively rather than inferred from an outcome.
 *
 * A key with no scripted entry throws, so a test can never accidentally pass
 * because an unexpected read silently returned a benign default.
 */
export function recordingAuthorityReader(
  script: Readonly<Record<string, () => ValidatedConsentActivationAuthoritySnapshot>>,
): RecordingAuthorityReader {
  const reads: string[] = [];
  return {
    reads,
    read: async (policyKey: string) => {
      reads.push(policyKey);
      const entry = script[policyKey];
      if (!entry) {
        throw new Error(`No authority scripted for '${policyKey}'.`);
      }
      return entry();
    },
  };
}
