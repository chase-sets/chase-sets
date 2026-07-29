import type {
  ConsentActivationAuthoritySnapshot,
  ConsentActivationGuard,
} from "@chase-sets/platform-policy/consent-activation-authority";
import {
  publicPolicyHrefsByKey,
  publicPolicyPublicationRecords,
  publicPolicyPublicationStatuses,
  type PublicPolicyPublicationRecord,
} from "@chase-sets/public-docs";
import { IdentityDomainError, type ConsentSubjectType } from "../../../support/runtime-support/common";
import { TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN } from "./terms-of-service";
import {
  identityConsentActiveVersionPolicies,
  isIdentityConsentPolicyKey,
  type IdentityConsentPolicyKey,
} from "./terms-of-service-policy";

/**
 * The Consent Bundle: the ordered set of policies one surface asks a subject to
 * agree to, plus the scope the resulting Consents are recorded at.
 *
 * Two contracts live in this module and they are deliberately NOT the same one.
 *
 * 1. THE MEMBER REGISTRY is a closed, declared list. Declaring a member says
 *    only "this policy belongs to this surface's bundle". It is not a
 *    requirement and it is not a default: there is no options bag, no override,
 *    and no caller-supplied widening anywhere in this module.
 * 2. THE REQUIREMENT SET is DERIVED, per resolution, from two independent facts
 *    about each member -- the compiled publication record says the artifact is
 *    consent-activatable, AND that member's Consent Activation Authority reports
 *    it active. A member missing either is omitted. Adding a member therefore
 *    requires nothing; only publication plus activation does.
 *
 * The empty requirement set the shipped corpus produces today is a VALUE, not a
 * disabled mode. Nothing in this module -- or in any caller of it -- reads the
 * length of a requirement set to decide whether a resolution, a guard, or the
 * invariant applies.
 *
 * Ordering is part of the contract. Declared member order is the order
 * requirements are emitted in, because a minted registration resolution signs
 * requirement order: reordering the list is tampering, not an equivalent
 * encoding.
 */

export const CONSENT_BUNDLE_KEYS = ["registration", "seller-onboarding"] as const;

export type ConsentBundleKey = (typeof CONSENT_BUNDLE_KEYS)[number];

export type ConsentBundleMember = Readonly<{
  /**
   * The canonical Consent policy key. It is simultaneously the Public Presence
   * publication key -- which supplies publication state, version, and href --
   * and the key recorded on the Consent fact, so the document a person read and
   * the fact recorded about them can never name different policies.
   */
  policyKey: IdentityConsentPolicyKey;
}>;

/**
 * Who performs the recording. A subject records their own user-scoped Consent;
 * an account-scoped Consent is recorded by an authorized member of that account,
 * with the acting user captured alongside the account subject.
 */
export type ConsentBundleRecordingAuthority = "subject" | "authorized-account-member";

export type ConsentBundle = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: ConsentSubjectType;
  recordedBy: ConsentBundleRecordingAuthority;
  members: readonly ConsentBundleMember[];
}>;

/**
 * The registration bundle: user-scoped, affirmed by the person creating the
 * identity. Its resolved requirement set is what a minted Registration Consent
 * Resolution carries.
 */
export const registrationConsentBundle: ConsentBundle = {
  bundleKey: "registration",
  subjectType: "user",
  recordedBy: "subject",
  members: [{ policyKey: "terms-of-service" }, { policyKey: "privacy-policy" }],
};

/**
 * The seller-onboarding bundle: account-scoped, recorded by an authorized
 * account member with the acting user captured.
 *
 * DEFINING it is this module's job. WIRING it -- deciding which account members
 * may bind an account, and gating listing publication on whether an account has
 * satisfied it -- is reserved for the seller-gating slice (issue 5694) and does
 * not exist at this head. Nothing in this repository currently resolves or
 * enforces this bundle on a seller surface.
 */
export const sellerOnboardingConsentBundle: ConsentBundle = {
  bundleKey: "seller-onboarding",
  subjectType: "account",
  recordedBy: "authorized-account-member",
  members: [{ policyKey: "seller-agreement" }, { policyKey: "payments-terms" }],
};

export const consentBundles = {
  registration: registrationConsentBundle,
  "seller-onboarding": sellerOnboardingConsentBundle,
} as const satisfies Readonly<Record<ConsentBundleKey, ConsentBundle>>;

export function getConsentBundle(bundleKey: ConsentBundleKey): ConsentBundle {
  return consentBundles[bundleKey];
}

/**
 * The bundles that declare `policyKey`, in declaration order. A key no bundle
 * declares -- including the history-only legacy Terms of Service alias -- is
 * outside the bundle rules entirely and is never recordable through them.
 */
export function consentBundlesDeclaring(policyKey: string): readonly ConsentBundleKey[] {
  return CONSENT_BUNDLE_KEYS.filter((bundleKey) =>
    consentBundles[bundleKey].members.some((member) => member.policyKey === policyKey),
  );
}

/** The platform-policy key whose Consent Activation Authority owns this member's activation. */
export function consentBundleMemberActivationPolicyKey(policyKey: IdentityConsentPolicyKey): string {
  return identityConsentActiveVersionPolicies[policyKey].policyKey;
}

/** One resolved element of a bundle: the policy, the exact version, and where it is readable. */
export type ConsentBundleRequirement = Readonly<{
  policyKey: string;
  version: string;
  href: string;
}>;

/**
 * The compiled corpus this context assesses members against. Public Presence
 * owns publication; this binding is the one place Identity names that corpus,
 * so every consent path in the context reads the same build-time facts and none
 * of them re-derives readiness.
 */
export type ConsentPublicationCorpus = Readonly<Record<IdentityConsentPolicyKey, PublicPolicyPublicationRecord>>;

export const identityConsentPublicationCorpus: ConsentPublicationCorpus = publicPolicyPublicationRecords;

export type ConsentMemberPublicationAssessment =
  | Readonly<{ state: "activatable"; version: string; href: string }>
  | Readonly<{ state: "not-consent-activatable" }>
  | Readonly<{ state: "unresolved"; reason: string }>;

/**
 * The publication half of the invariant, as a pure function of the compiled
 * record.
 *
 * `consentActivatable` is CONSUMED, never re-derived: readiness (published
 * status, counsel approval, non-blank operative copy in every section) is Public
 * Presence's evaluation, compiled into the record at build time. Re-deriving it
 * here would let the two seams disagree.
 *
 * Key presence is not value validity, so the record's own envelope is validated
 * before any of it is used: an absent record, a non-boolean flag, a version that
 * is not a canonical `vN` token, or an href that disagrees with the canonical
 * route for that key each yield `unresolved` rather than a fallback.
 */
export function assessConsentMemberPublication(
  policyKey: IdentityConsentPolicyKey,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): ConsentMemberPublicationAssessment {
  const record: unknown = Object.prototype.hasOwnProperty.call(corpus, policyKey) ? corpus[policyKey] : undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { state: "unresolved", reason: `No publication record is compiled for '${policyKey}'.` };
  }

  const candidate = record as Record<string, unknown>;
  if (candidate.policyKey !== policyKey) {
    return {
      state: "unresolved",
      reason: `The publication record indexed at '${policyKey}' names '${String(candidate.policyKey)}'.`,
    };
  }
  if (typeof candidate.consentActivatable !== "boolean") {
    return { state: "unresolved", reason: `The publication record for '${policyKey}' has no boolean activatability.` };
  }
  if (
    typeof candidate.publicationStatus !== "string" ||
    !(publicPolicyPublicationStatuses as readonly string[]).includes(candidate.publicationStatus)
  ) {
    return {
      state: "unresolved",
      reason: `The publication record for '${policyKey}' has no known publication status.`,
    };
  }
  if (typeof candidate.version !== "string" || !TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(candidate.version)) {
    return {
      state: "unresolved",
      reason: `The publication record for '${policyKey}' carries a non-canonical version.`,
    };
  }
  if (candidate.href !== publicPolicyHrefsByKey[policyKey]) {
    return { state: "unresolved", reason: `The publication record for '${policyKey}' names a non-canonical href.` };
  }

  if (!candidate.consentActivatable) {
    return { state: "not-consent-activatable" };
  }
  return { state: "activatable", version: candidate.version, href: publicPolicyHrefsByKey[policyKey] };
}

export type ConsentBundleMemberDisposition =
  /** The compiled artifact is not consent-activatable. Declared, never required. */
  | "omitted-not-consent-activatable"
  /** Consent-activatable, but its authority does not report the key active. */
  | "omitted-not-activated"
  /** Consent-activatable and activated: a requirement. */
  | "required"
  /** A record or snapshot that could not be trusted. Fails the whole resolution closed. */
  | "unresolved";

export type ConsentBundleMemberResolution = Readonly<{
  policyKey: IdentityConsentPolicyKey;
  activationPolicyKey: string;
  disposition: ConsentBundleMemberDisposition;
  /** The published version this member was assessed against, when the record was readable. */
  publicationVersion: string | null;
  requirement: ConsentBundleRequirement | null;
  /**
   * The authority guard token, present for exactly the members whose authority
   * was read. A member omitted for not being consent-activatable carries none:
   * the compiled corpus cannot change inside a running process, so a member that
   * is not consent-activatable now cannot become required before the process is
   * replaced, and there is no window for a guard to protect.
   */
  guard: ConsentActivationGuard | null;
  unresolvedReason: string | null;
}>;

export type ConsentBundleUnresolvedMember = Readonly<{ policyKey: string; reason: string }>;

export type ConsentBundleResolution = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: ConsentSubjectType;
  recordedBy: ConsentBundleRecordingAuthority;
  members: readonly ConsentBundleMemberResolution[];
  /** The derived, ordered requirement set. Empty is a value, never a disabled mode. */
  requirements: readonly ConsentBundleRequirement[];
  /** The guard tokens the requirement set was resolved against, in member order. */
  guards: readonly ConsentActivationGuard[];
  /** Every member whose publication record or authority snapshot could not be trusted. */
  unresolved: readonly ConsentBundleUnresolvedMember[];
}>;

/** Reads one member's Consent Activation Authority. The only activation input a resolution takes. */
export type ConsentActivationAuthorityReader = (policyKey: string) => Promise<ConsentActivationAuthoritySnapshot>;

export class ConsentBundleUnresolvedError extends IdentityDomainError {
  public readonly code = "consent_bundle_unresolved";

  public constructor(
    public readonly bundleKey: ConsentBundleKey,
    public readonly unresolved: readonly ConsentBundleUnresolvedMember[],
  ) {
    super(
      `Consent Bundle '${bundleKey}' could not be resolved: ${unresolved
        .map((member) => `${member.policyKey}: ${member.reason}`)
        .join("; ")}`,
    );
    this.name = "ConsentBundleUnresolvedError";
  }
}

/**
 * Validates one authority snapshot before any of it is trusted. The snapshot is
 * the shared platform-policy machinery's value, but a caller that hands this
 * module a hand-built object must not be able to steer a requirement: the shape,
 * the key it names, and the version token are all checked here.
 */
function assessActivation(
  activationPolicyKey: string,
  snapshot: unknown,
): Readonly<{ ok: true; snapshot: ConsentActivationAuthoritySnapshot }> | Readonly<{ ok: false; reason: string }> {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return { ok: false, reason: `The activation authority for '${activationPolicyKey}' returned no snapshot.` };
  }
  const candidate = snapshot as Record<string, unknown>;
  if (candidate.policyKey !== activationPolicyKey) {
    return {
      ok: false,
      reason: `The activation authority snapshot names '${String(candidate.policyKey)}', not '${activationPolicyKey}'.`,
    };
  }
  if (typeof candidate.isActive !== "boolean") {
    return { ok: false, reason: `The activation authority snapshot for '${activationPolicyKey}' has no active state.` };
  }
  const guard = candidate.guard;
  if (
    typeof guard !== "object" ||
    guard === null ||
    (guard as Record<string, unknown>).policyKey !== activationPolicyKey ||
    typeof (guard as Record<string, unknown>).streamId !== "string"
  ) {
    return { ok: false, reason: `The activation authority snapshot for '${activationPolicyKey}' has no usable guard.` };
  }
  const expectedVersion = (guard as Record<string, unknown>).expectedVersion;
  if (expectedVersion !== "no_stream" && !(typeof expectedVersion === "number" && Number.isInteger(expectedVersion))) {
    return { ok: false, reason: `The activation authority guard for '${activationPolicyKey}' has no exact revision.` };
  }
  if (candidate.isActive && typeof candidate.activeVersion !== "string") {
    return { ok: false, reason: `The activation authority for '${activationPolicyKey}' is active at no version.` };
  }
  return { ok: true, snapshot: snapshot as ConsentActivationAuthoritySnapshot };
}

/**
 * THE resolution. Ordered, derived, and authority-bound.
 *
 * Every activation fact -- state, active version, and the guard revision -- comes
 * from ONE read of the authority stream per member, via `readAuthority`. No
 * cached policy value is read anywhere on this path and none is paired with a
 * separately read revision, which is the pairing this module exists to make
 * unrepresentable.
 *
 * A member the corpus reports as not consent-activatable is skipped BEFORE its
 * authority is read: an unpublished document has nothing to activate, and
 * reading its authority would invite the guard on an omitted member to look like
 * part of the invariant.
 */
export async function resolveConsentBundle(
  bundleKey: ConsentBundleKey,
  readAuthority: ConsentActivationAuthorityReader,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): Promise<ConsentBundleResolution> {
  const bundle = getConsentBundle(bundleKey);
  const members: ConsentBundleMemberResolution[] = [];

  for (const member of bundle.members) {
    const activationPolicyKey = consentBundleMemberActivationPolicyKey(member.policyKey);
    const publication = assessConsentMemberPublication(member.policyKey, corpus);

    if (publication.state === "unresolved") {
      members.push(unresolvedMember(member.policyKey, activationPolicyKey, null, publication.reason));
      continue;
    }
    if (publication.state === "not-consent-activatable") {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "omitted-not-consent-activatable",
        publicationVersion: null,
        requirement: null,
        guard: null,
        unresolvedReason: null,
      });
      continue;
    }

    let snapshot: unknown;
    try {
      snapshot = await readAuthority(activationPolicyKey);
    } catch (error) {
      members.push(
        unresolvedMember(
          member.policyKey,
          activationPolicyKey,
          publication.version,
          `The activation authority read failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    const activation = assessActivation(activationPolicyKey, snapshot);
    if (!activation.ok) {
      members.push(unresolvedMember(member.policyKey, activationPolicyKey, publication.version, activation.reason));
      continue;
    }

    if (!activation.snapshot.isActive) {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "omitted-not-activated",
        publicationVersion: publication.version,
        requirement: null,
        guard: activation.snapshot.guard,
        unresolvedReason: null,
      });
      continue;
    }

    // Publication and activation must name the same version. Two authorities
    // agreeing on "active" while disagreeing on WHICH version is active is not a
    // requirement that can be honestly presented, so it fails closed rather than
    // picking either side.
    if (activation.snapshot.activeVersion !== publication.version) {
      members.push(
        unresolvedMember(
          member.policyKey,
          activationPolicyKey,
          publication.version,
          `The activation authority is active at '${String(activation.snapshot.activeVersion)}' while the published artifact is '${publication.version}'.`,
        ),
      );
      continue;
    }

    members.push({
      policyKey: member.policyKey,
      activationPolicyKey,
      disposition: "required",
      publicationVersion: publication.version,
      requirement: { policyKey: member.policyKey, version: publication.version, href: publication.href },
      guard: activation.snapshot.guard,
      unresolvedReason: null,
    });
  }

  const unresolved = members
    .filter((member) => member.disposition === "unresolved")
    .map((member) => ({ policyKey: member.policyKey, reason: member.unresolvedReason ?? "unknown" }));

  return {
    bundleKey,
    subjectType: bundle.subjectType,
    recordedBy: bundle.recordedBy,
    members,
    requirements: members.flatMap((member) => (member.requirement ? [member.requirement] : [])),
    guards: members.flatMap((member) => (member.disposition === "required" && member.guard ? [member.guard] : [])),
    unresolved,
  };
}

/**
 * The resolution a caller may act on. An unresolved member merges the whole
 * bundle into one exact failure rather than yielding a partial requirement set:
 * a caller cannot be handed "these three of four", because acting on it would
 * record acceptance of a bundle nobody could fully describe.
 */
export async function requireResolvedConsentBundle(
  bundleKey: ConsentBundleKey,
  readAuthority: ConsentActivationAuthorityReader,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): Promise<ConsentBundleResolution> {
  const resolution = await resolveConsentBundle(bundleKey, readAuthority, corpus);
  if (resolution.unresolved.length > 0) {
    throw new ConsentBundleUnresolvedError(bundleKey, resolution.unresolved);
  }
  return resolution;
}

/**
 * The ordered requirement set a minted Registration Consent Resolution carries.
 *
 * The registration bundle's declared order IS the signed order: the resolution's
 * signature covers requirement order, so reordering is tampering rather than an
 * equivalent encoding, and the order therefore has to come from the declaration
 * rather than from whatever order the authority reads happened to complete in.
 *
 * Fails closed as a whole. A member whose publication record or authority
 * snapshot cannot be trusted stops the mint rather than yielding a partial
 * requirement set that a person would then be asked to affirm.
 */
export async function resolveRegistrationConsentRequirements(
  readAuthority: ConsentActivationAuthorityReader,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): Promise<readonly ConsentBundleRequirement[]> {
  const resolution = await requireResolvedConsentBundle("registration", readAuthority, corpus);
  return resolution.requirements;
}

function unresolvedMember(
  policyKey: IdentityConsentPolicyKey,
  activationPolicyKey: string,
  publicationVersion: string | null,
  reason: string,
): ConsentBundleMemberResolution {
  return {
    policyKey,
    activationPolicyKey,
    disposition: "unresolved",
    publicationVersion,
    requirement: null,
    guard: null,
    unresolvedReason: reason,
  };
}

/* -------------------------------------------------------------------------- */
/* The publication half of the recording admission                             */
/* -------------------------------------------------------------------------- */

export type ConsentRecordingPublicationVerdict =
  | Readonly<{ admitted: true; bundleKeys: readonly ConsentBundleKey[]; version: string; href: string }>
  | Readonly<{ admitted: false; code: ConsentRecordingPublicationRefusalCode; message: string }>;

export type ConsentRecordingPublicationRefusalCode =
  /** The key no bundle declares -- including the history-only legacy alias -- is never newly recordable. */
  | "consent_policy_not_bundle_member"
  /** The compiled artifact is not consent-activatable, so no version of it can be accepted. */
  | "consent_policy_not_publication_activatable"
  /** The compiled record could not be trusted at all. */
  | "consent_policy_publication_unresolved"
  /** The version offered is not the published version. */
  | "consent_policy_version_not_published";

/**
 * The pure publication half of the recording rule, so it holds on every path
 * into the decider rather than only on the paths that go through the API
 * runtime. It reads only build-time facts and therefore needs no I/O.
 *
 * Legacy history is preserved by omission, not by a special case: `terms` is not
 * a declared member, so it lands on `consent_policy_not_bundle_member` and can
 * never be newly recorded, while every already-recorded legacy fact stays
 * readable exactly as before.
 */
export function assessConsentRecordingPublication(
  policyKey: string,
  policyVersion: string,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): ConsentRecordingPublicationVerdict {
  if (!isIdentityConsentPolicyKey(policyKey)) {
    return {
      admitted: false,
      code: "consent_policy_not_bundle_member",
      message: `Policy '${policyKey}' is not a Consent Bundle member and cannot carry a newly recorded Consent.`,
    };
  }

  const bundleKeys = consentBundlesDeclaring(policyKey);
  if (bundleKeys.length === 0) {
    return {
      admitted: false,
      code: "consent_policy_not_bundle_member",
      message: `Policy '${policyKey}' is declared by no Consent Bundle.`,
    };
  }

  const publication = assessConsentMemberPublication(policyKey, corpus);
  if (publication.state === "unresolved") {
    return {
      admitted: false,
      code: "consent_policy_publication_unresolved",
      message: publication.reason,
    };
  }
  if (publication.state === "not-consent-activatable") {
    return {
      admitted: false,
      code: "consent_policy_not_publication_activatable",
      message: `The published artifact for '${policyKey}' is not consent-activatable, so no version of it can be accepted.`,
    };
  }
  if (policyVersion !== publication.version) {
    return {
      admitted: false,
      code: "consent_policy_version_not_published",
      message: `Consent for '${policyKey}' was offered at '${policyVersion}' while the published version is '${publication.version}'.`,
    };
  }

  return { admitted: true, bundleKeys, version: publication.version, href: publication.href };
}

/** True when the publication half admits this recording. The activation half is decided separately, after. */
export function isConsentRecordingPublicationAdmitted(
  policyKey: string,
  policyVersion: string,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): boolean {
  return assessConsentRecordingPublication(policyKey, policyVersion, corpus).admitted;
}

/**
 * The bundle a recording at this scope belongs to. A member declared by exactly
 * one bundle of the offered subject type binds unambiguously; a key declared by
 * bundles of two different scopes would be ambiguous and is refused rather than
 * resolved by precedence.
 */
export function consentBundleForRecording(policyKey: string, subjectType: ConsentSubjectType): ConsentBundle | null {
  const matches = consentBundlesDeclaring(policyKey)
    .map((bundleKey) => consentBundles[bundleKey])
    .filter((bundle) => bundle.subjectType === subjectType);
  return matches.length === 1 ? (matches[0] as ConsentBundle) : null;
}
