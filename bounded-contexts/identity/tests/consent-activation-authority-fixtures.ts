import {
  consentActivationAuthorityStreamId,
  decodeConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationAuthoritySnapshot,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityRuntime } from "@chase-sets/platform-policy/runtime";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { publicPolicyHrefsByKey, type PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import {
  resolveConsentBundleAgainstCorpus,
  type ConsentActivationAuthorityReader,
  type ConsentPolicyPublicationCorpus,
  type RegistrationConsentBundleResolver,
} from "../features/consents/domain/consent-bundle";
import {
  IDENTITY_CONSENT_POLICY_KEYS,
  identityConsentActiveVersionPolicyFor,
  type IdentityConsentPolicyKey,
} from "../features/consents/domain/terms-of-service-policy";
import { REGISTRATION_CONSENT_BUNDLE_KEY } from "../features/consents/domain/registration-consent";

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

/**
 * A publication record in the exact compiled shape, with `consentActivatable`
 * chosen by the caller.
 *
 * The shipped corpus compiles every policy as not consent-activatable, so a
 * suite that needs a live member has to supply one. It is a fixture publication
 * paired with a fixture authority -- never a production record with a flag
 * flipped -- so no test can pass by making the real corpus look activatable.
 */
export function consentPublicationFixture(
  policyKey: IdentityConsentPolicyKey,
  version: `v${number}`,
  consentActivatable: boolean,
): PublicPolicyPublicationRecord {
  return {
    policyKey,
    version,
    locale: "en",
    href: publicPolicyHrefsByKey[policyKey],
    publicationStatus: consentActivatable ? "published" : "counsel-review-required",
    effectiveAt: consentActivatable ? "2026-07-01T00:00:00.000Z" : null,
    counselApprovalReference: consentActivatable ? "counsel-fixture-1" : null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
    contentFingerprint: `sha256:fixture-${policyKey}-${version}`,
    consentActivatable,
  } as PublicPolicyPublicationRecord;
}

/** One declared bundle member made live: a published, activatable artifact at an active authority. */
export type ActivatedConsentMember = Readonly<{ policyKey: IdentityConsentPolicyKey; version: `v${number}` }>;

/**
 * A fixture corpus in which exactly the named members are consent-activatable
 * at the named versions and every other declared key stays ineligible.
 */
export function fixtureConsentPolicyPublications(
  activated: readonly ActivatedConsentMember[],
): ConsentPolicyPublicationCorpus {
  const versions = new Map(activated.map((member) => [member.policyKey, member.version] as const));
  const corpus = {} as Record<IdentityConsentPolicyKey, PublicPolicyPublicationRecord>;
  for (const policyKey of IDENTITY_CONSENT_POLICY_KEYS) {
    const version = versions.get(policyKey);
    corpus[policyKey] = consentPublicationFixture(policyKey, version ?? "v0", version !== undefined);
  }
  return corpus;
}

/**
 * An authority reader whose scripted snapshots make exactly the named members
 * active at their published versions, keyed by each member's active-version
 * policy key -- the same indirection production resolves through.
 */
export function fixtureBundleAuthorityReader(
  activated: readonly ActivatedConsentMember[],
  overrides: Readonly<Record<string, () => ValidatedConsentActivationAuthoritySnapshot>> = {},
): RecordingAuthorityReader {
  const script: Record<string, () => ValidatedConsentActivationAuthoritySnapshot> = {};
  for (const member of activated) {
    const activeVersionPolicyKey = identityConsentActiveVersionPolicyFor(member.policyKey).policyKey;
    script[activeVersionPolicyKey] = () => activeSnapshot(activeVersionPolicyKey, member.version);
  }
  return recordingAuthorityReader({ ...script, ...overrides });
}

/**
 * Reads an ordered requirement list back as the members that would have to be
 * activated for the current bundle to derive it. Rejects anything outside the
 * declared vocabulary or the canonical version shape, so a suite cannot
 * activate a member that production could never derive.
 */
export function activatedMembersFor(
  requirements: readonly Readonly<{ policyKey: string; version: string }>[],
): readonly ActivatedConsentMember[] {
  return requirements.map((requirement) => {
    if (!(IDENTITY_CONSENT_POLICY_KEYS as readonly string[]).includes(requirement.policyKey)) {
      throw new Error(`'${requirement.policyKey}' is not a declared Identity consent policy key.`);
    }
    if (!/^v[0-9]+$/.test(requirement.version)) {
      throw new Error(`'${requirement.version}' is not a canonical consent policy version.`);
    }
    return {
      policyKey: requirement.policyKey as IdentityConsentPolicyKey,
      version: requirement.version as `v${number}`,
    };
  });
}

export type FixtureRegistrationConsentBundleResolver = RegistrationConsentBundleResolver &
  Readonly<{
    /** Replace the activated members, as an operator activating a policy would. */
    activate: (members: readonly ActivatedConsentMember[]) => void;
    /** The authority reader the next resolve will consult, with its read trace. */
    authority: () => RecordingAuthorityReader;
    /** How many times the registration path asked for the bundle. */
    resolveCount: () => number;
  }>;

/**
 * The registration bundle seam, resolved through the REAL
 * `resolveConsentBundleAgainstCorpus` against fixture publications and fixture
 * authorities.
 *
 * Nothing here hand-builds a resolution: requirement derivation, guard
 * retention, ordering and the unresolved arm are all the production functions,
 * so a suite that uses this exercises the same derivation production does and
 * the guards it hands back are minted by the canonical decoder.
 */
export function fixtureRegistrationConsentBundleResolver(
  activated: readonly ActivatedConsentMember[] = [],
  options: Readonly<{
    authority?: RecordingAuthorityReader;
    corpus?: ConsentPolicyPublicationCorpus;
  }> = {},
): FixtureRegistrationConsentBundleResolver {
  // An injected authority is the real one (an event store, a spy over it), so
  // `activate` must not replace it -- activation there is a real event append,
  // not a swapped script. Only the publication half is a fixture in that mode.
  const injectedAuthority = options.authority;
  let authority = injectedAuthority ?? fixtureBundleAuthorityReader(activated);
  let corpus = options.corpus ?? fixtureConsentPolicyPublications(activated);
  let resolveCount = 0;

  return {
    activate: (members) => {
      if (!injectedAuthority) {
        authority = fixtureBundleAuthorityReader(members);
      }
      corpus = fixtureConsentPolicyPublications(members);
    },
    authority: () => authority,
    resolveCount: () => resolveCount,
    resolve: async () => {
      resolveCount += 1;
      return resolveConsentBundleAgainstCorpus(authority, REGISTRATION_CONSENT_BUNDLE_KEY, corpus);
    },
  };
}

/**
 * The stream revision `activeSnapshot` describes: one registration event plus
 * one activation event.
 */
export const FIXTURE_ACTIVE_AUTHORITY_REVISION = 2;

/**
 * Bring a fixture authority stream to an explicit revision in a store that is
 * NOT the source of the scripted snapshots.
 *
 * A scripted snapshot hands out a guard for a revision; the guard is then
 * checked against whatever the store actually holds. A suite that scripts an
 * active authority without seeding its stream is guarding revision 2 against an
 * empty stream, which conflicts for the wrong reason. The events are
 * placeholders -- nothing replays this stream, and the guard is a version
 * assertion.
 */
export async function seedFixtureAuthorityRevision(
  eventStore: Pick<EventStore, "appendToStream">,
  policyKey: IdentityConsentPolicyKey,
  context: EventStoreContext,
  revision: number = FIXTURE_ACTIVE_AUTHORITY_REVISION,
): Promise<void> {
  if (revision <= 0) {
    return;
  }
  await eventStore.appendToStream({
    streamId: consentActivationAuthorityStreamId(identityConsentActiveVersionPolicyFor(policyKey).policyKey),
    expectedVersion: "no_stream",
    events: Array.from({ length: revision }, () => ({
      eventType: "platform-policy.consent-activation-authority.registered",
      payload: {},
    })),
    context,
  });
}

/**
 * Wraps a real authority surface -- an event-store-backed
 * `ConsentActivationAuthorityRuntime`, typically -- in the same read trace the
 * scripted reader carries, so "zero authority reads" is asserted the same way
 * against real PostgreSQL as it is in a unit spec.
 */
export function recordingAuthorityReaderOver(reader: ConsentActivationAuthorityReader): RecordingAuthorityReader {
  const reads: string[] = [];
  return {
    reads,
    read: async (policyKey: string) => {
      reads.push(policyKey);
      return reader.read(policyKey);
    },
  };
}

/**
 * Activates one declared consent member on the REAL Consent Activation
 * Authority, through the owning context's own register/activate commands.
 *
 * Deliberately not a hand-written pair of appends: the authority stream a
 * guard is checked against must be one production actually produced, or a
 * passing guard proves nothing about production's revision arithmetic.
 */
export async function activateRealConsentAuthority(
  consentActivation: ConsentActivationAuthorityRuntime,
  context: EventStoreContext,
  member: ActivatedConsentMember,
  actorUserId = "usr_activation_operator",
): Promise<void> {
  const definition = identityConsentActiveVersionPolicyFor(member.policyKey);
  await consentActivation.register(definition, context);
  await consentActivation.activate(
    definition,
    { version: member.version, documentId: `pol_${member.policyKey}_${member.version}`, actorUserId },
    context,
  );
}
