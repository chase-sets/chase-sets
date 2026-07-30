import {
  ConsentActivationAuthorityError,
  type ValidatedConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationGuard,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityRuntime } from "@chase-sets/platform-policy/runtime";
import {
  publicPolicyHrefsByKey,
  publicPolicyPublicationRecords,
  type PublicPolicyPublicationRecord,
} from "@chase-sets/public-docs";
import {
  identityConsentActiveVersionPolicyFor,
  isIdentityConsentPolicyKey,
  type IdentityConsentPolicyKey,
} from "./terms-of-service-policy";
import { IdentityDomainError } from "../../../support/runtime-support/common";

/**
 * A Consent Bundle is the ordered set of consent policies one surface asks a
 * subject to agree to, plus the scope the agreement is recorded against.
 *
 * Three separations are the whole point of this module, and every change here
 * must preserve all three.
 *
 * 1. DECLARED MEMBER IS NOT DERIVED REQUIREMENT. A bundle declaration names the
 *    policies that are *allowed* to be required by that surface. Whether a
 *    declared member actually becomes a requirement is decided per member, from
 *    published metadata and that policy's Consent Activation Authority. Adding a
 *    member to a declaration therefore never activates it, and the two contracts
 *    are separate closed types so a caller cannot read one as the other.
 *
 * 2. ORDER IS CONTRACT, NOT INCIDENTAL. Declared member order is the order a
 *    subject is asked, and the order a derived requirement list carries. It is
 *    not the order a map iterates or a query returns.
 *
 * 3. ACTIVATION COMES FROM ONE VALIDATED AUTHORITY READ. Requirement derivation
 *    reads activation state, active version, and the guard token from one
 *    `ConsentActivationAuthorityRuntime.read` call per member -- the validated
 *    snapshot decoder in `infrastructure/platform-policy`. It never resolves a
 *    policy document, never touches the cached policy value, and never pairs a
 *    value read at one moment with a revision read at another. The reader type
 *    below is a `Pick` of the real runtime interface precisely so a cached
 *    `resolvePolicy` is not reachable from anything this module is handed.
 *
 * Emptiness is a value, not a disabled mode. Nothing here reads the length of a
 * declared member list or a derived requirement list to decide whether
 * resolution runs, whether a guard is retained, or whether a bundle applies.
 *
 * This slice delivers the domain and read side only. No write or admission path
 * consumes a resolved bundle yet; binding Consent recording and registration to
 * a resolved bundle is owned by the terminal replacement slice.
 */

export type ConsentSubjectScope = "user" | "account";

export const CONSENT_BUNDLE_KEYS = ["registration", "seller-onboarding"] as const;

export type ConsentBundleKey = (typeof CONSENT_BUNDLE_KEYS)[number];

/**
 * One bundle's declaration: which subject the agreement is recorded against,
 * and which consent policies that surface is allowed to require, in order.
 */
export type ConsentBundleDeclaration = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectScope: ConsentSubjectScope;
  members: readonly IdentityConsentPolicyKey[];
}>;

/**
 * The closed bundle registry. `registration` is user-scoped: creating a
 * personal identity is an act of a person. `seller-onboarding` is
 * account-scoped: the seller obligations bind the selling account, with the
 * acting user captured by the write slice that records the agreement.
 */
export const consentBundleDeclarations = {
  registration: {
    bundleKey: "registration",
    subjectScope: "user",
    members: ["terms-of-service", "privacy-policy"],
  },
  "seller-onboarding": {
    bundleKey: "seller-onboarding",
    subjectScope: "account",
    members: ["seller-agreement", "payments-terms"],
  },
} as const satisfies Readonly<Record<ConsentBundleKey, ConsentBundleDeclaration>>;

export function isConsentBundleKey(bundleKey: string): bundleKey is ConsentBundleKey {
  return (CONSENT_BUNDLE_KEYS as readonly string[]).includes(bundleKey);
}

/** Resolves a bundle declaration. Unknown bundle keys reject. */
export function consentBundleDeclarationFor(bundleKey: string): ConsentBundleDeclaration {
  if (!isConsentBundleKey(bundleKey)) {
    throw new IdentityDomainError(`Consent bundle key '${bundleKey}' is not a recognized Consent Bundle.`);
  }
  return consentBundleDeclarations[bundleKey];
}

/**
 * One derived requirement: the consent policy key a Consent is recorded under,
 * the exact active version, and where that version is readable. Deliberately a
 * different type from `ConsentBundleDeclaration["members"]` -- a declared member
 * is a key, a requirement is a key bound to a version that an authority says is
 * active right now.
 */
export type ConsentBundleRequirement = Readonly<{
  policyKey: IdentityConsentPolicyKey;
  version: string;
  href: string;
}>;

/**
 * A retained guard for one authority that was actually read. Carried so the
 * write slice can commit against the exact revision this resolution observed;
 * a guard is retained for every authority read, including members observed
 * inactive, because "inactive when read" is a fact a later append must be able
 * to guard against.
 */
export type ConsentActivationGuardBinding = Readonly<{
  policyKey: IdentityConsentPolicyKey;
  activeVersionPolicyKey: string;
  guard: ValidatedConsentActivationGuard;
}>;

export const CONSENT_BUNDLE_UNRESOLVED_REASONS = [
  /** The authority is active at a version the published artifact does not carry. */
  "publication-activation-version-mismatch",
  /** The authority is active but carries no active version -- a state its decoder should make unreachable. */
  "authority-lifecycle-incoherent",
  /** The authority could not be read or validated, so no activation fact exists to derive from. */
  "authority-unreadable",
] as const;

export type ConsentBundleUnresolvedReason = (typeof CONSENT_BUNDLE_UNRESOLVED_REASONS)[number];

export type ConsentBundleMemberOutcome =
  /** Not publication-ready, so no authority was read and no guard exists. */
  | Readonly<{ kind: "publication-ineligible"; policyKey: IdentityConsentPolicyKey }>
  /** Publication-ready, authority read, not activated. Omitted; its guard is retained. */
  | Readonly<{
      kind: "omitted-inactive";
      policyKey: IdentityConsentPolicyKey;
      authorityStatus: ValidatedConsentActivationAuthoritySnapshot["status"];
    }>
  /** Publication-ready and activated at the published version. */
  | Readonly<{ kind: "required"; policyKey: IdentityConsentPolicyKey; requirement: ConsentBundleRequirement }>
  /** The member's activation fact contradicts itself or could not be read. */
  | Readonly<{
      kind: "unresolved";
      policyKey: IdentityConsentPolicyKey;
      reason: ConsentBundleUnresolvedReason;
    }>;

export type ConsentBundleResolution =
  | Readonly<{
      bundleKey: ConsentBundleKey;
      subjectScope: ConsentSubjectScope;
      resolved: true;
      /** Ordered exactly as declared, containing only members derived as required. */
      requirements: readonly ConsentBundleRequirement[];
      /** One entry per authority actually read, ordered as declared. */
      guards: readonly ConsentActivationGuardBinding[];
      /** One entry per declared member, ordered as declared. */
      outcomes: readonly ConsentBundleMemberOutcome[];
    }>
  | Readonly<{
      bundleKey: ConsentBundleKey;
      subjectScope: ConsentSubjectScope;
      resolved: false;
      unresolvedPolicyKey: IdentityConsentPolicyKey;
      unresolvedReason: ConsentBundleUnresolvedReason;
      /** Guards retained up to the member that failed to resolve. */
      guards: readonly ConsentActivationGuardBinding[];
    }>;

/**
 * The authority surface this module needs: one validated read, keyed by policy
 * key. A `Pick` of the real `ConsentActivationAuthorityRuntime` rather than a
 * hand-written structural type, so a signature change in the owning context is
 * a compile error here instead of a runtime throw at a caller.
 *
 * It deliberately does not include `resolvePolicy`: the cached policy-document
 * value is not reachable from anything requirement derivation is handed.
 */
export type ConsentActivationAuthorityReader = Pick<ConsentActivationAuthorityRuntime, "read">;

/**
 * The publication metadata requirement derivation consults, keyed by consent
 * policy key. Supplied explicitly by the corpus-taking entry points so the
 * publication x activation matrix is exercisable; the no-options entry points
 * below bind it to the compiled corpus and are what production calls.
 */
export type ConsentPolicyPublicationCorpus = Readonly<Record<IdentityConsentPolicyKey, PublicPolicyPublicationRecord>>;

/**
 * The compiled corpus. Public Presence sets `consentActivatable` true only for a
 * published, readiness-valid artifact with reviewed operative copy, so a
 * placeholder stub or blank operative section can never become a requirement.
 */
export const identityConsentPolicyPublications = {
  "terms-of-service": publicPolicyPublicationRecords["terms-of-service"],
  "privacy-policy": publicPolicyPublicationRecords["privacy-policy"],
  "seller-agreement": publicPolicyPublicationRecords["seller-agreement"],
  "payments-terms": publicPolicyPublicationRecords["payments-terms"],
} as const satisfies ConsentPolicyPublicationCorpus;

export function identityConsentPolicyHref(policyKey: IdentityConsentPolicyKey): string {
  return publicPolicyHrefsByKey[policyKey];
}

/**
 * Whether a published artifact is eligible to carry consent at all. The
 * compiled flag is consumed, never re-derived: re-deriving it from
 * `publicationStatus` here would let Identity disagree with the compiler that
 * owns the publication-to-activation invariant.
 */
export function isConsentActivatablePublication(publication: PublicPolicyPublicationRecord): boolean {
  return publication.consentActivatable === true;
}

/**
 * Derives one member's outcome from its published metadata and its validated
 * authority snapshot. Pure: the caller has already decided a read was warranted
 * and performed it.
 */
export function deriveActivatedConsentMemberOutcome(
  policyKey: IdentityConsentPolicyKey,
  publication: PublicPolicyPublicationRecord,
  snapshot: ValidatedConsentActivationAuthoritySnapshot,
): ConsentBundleMemberOutcome {
  if (!snapshot.isActive) {
    return { kind: "omitted-inactive", policyKey, authorityStatus: snapshot.status };
  }
  if (snapshot.activeVersion === null) {
    return { kind: "unresolved", policyKey, reason: "authority-lifecycle-incoherent" };
  }
  if (snapshot.activeVersion !== publication.version) {
    return { kind: "unresolved", policyKey, reason: "publication-activation-version-mismatch" };
  }

  return {
    kind: "required",
    policyKey,
    requirement: {
      policyKey,
      version: snapshot.activeVersion,
      href: identityConsentPolicyHref(policyKey),
    },
  };
}

type ResolvedMember = Readonly<{
  outcome: ConsentBundleMemberOutcome;
  guard: ConsentActivationGuardBinding | null;
}>;

async function resolveMember(
  authority: ConsentActivationAuthorityReader,
  policyKey: IdentityConsentPolicyKey,
  publication: PublicPolicyPublicationRecord,
): Promise<ResolvedMember> {
  if (publication.policyKey !== policyKey) {
    throw new IdentityDomainError(
      `Consent publication for '${publication.policyKey}' cannot satisfy a read for '${policyKey}'.`,
    );
  }

  // Publication-ineligible short-circuits before any authority read: an
  // unpublishable document has no activation question to ask, and asking one
  // would make an inert member indistinguishable from a live one in the read
  // trace an operator inspects.
  if (!isConsentActivatablePublication(publication)) {
    return { outcome: { kind: "publication-ineligible", policyKey }, guard: null };
  }

  const activeVersionPolicyKey = identityConsentActiveVersionPolicyFor(policyKey).policyKey;

  let snapshot: ValidatedConsentActivationAuthoritySnapshot;
  try {
    snapshot = await authority.read(activeVersionPolicyKey);
  } catch (error) {
    // Only the authority's own named, coded failure is an unresolved
    // activation fact. Anything else is a defect in this process and must not
    // be laundered into a policy answer.
    if (error instanceof ConsentActivationAuthorityError) {
      return { outcome: { kind: "unresolved", policyKey, reason: "authority-unreadable" }, guard: null };
    }
    throw error;
  }

  return {
    outcome: deriveActivatedConsentMemberOutcome(policyKey, publication, snapshot),
    guard: { policyKey, activeVersionPolicyKey, guard: snapshot.guard },
  };
}

/**
 * Resolves a bundle against an explicitly supplied publication corpus.
 *
 * One unresolvable member makes the whole bundle unresolved. A surface cannot
 * ask for a partial agreement: if any declared member's activation fact
 * contradicts its publication or could not be read, there is no honest ordered
 * requirement list to present, and presenting a shorter one would record an
 * affirmation against a set the subject was never shown.
 */
export async function resolveConsentBundleAgainstCorpus(
  authority: ConsentActivationAuthorityReader,
  bundleKey: ConsentBundleKey,
  corpus: ConsentPolicyPublicationCorpus,
): Promise<ConsentBundleResolution> {
  const declaration = consentBundleDeclarationFor(bundleKey);
  const requirements: ConsentBundleRequirement[] = [];
  const guards: ConsentActivationGuardBinding[] = [];
  const outcomes: ConsentBundleMemberOutcome[] = [];

  for (const policyKey of declaration.members) {
    const { outcome, guard } = await resolveMember(authority, policyKey, corpus[policyKey]);
    if (guard) {
      guards.push(guard);
    }

    if (outcome.kind === "unresolved") {
      return {
        bundleKey: declaration.bundleKey,
        subjectScope: declaration.subjectScope,
        resolved: false,
        unresolvedPolicyKey: outcome.policyKey,
        unresolvedReason: outcome.reason,
        guards,
      };
    }

    outcomes.push(outcome);
    if (outcome.kind === "required") {
      requirements.push(outcome.requirement);
    }
  }

  return {
    bundleKey: declaration.bundleKey,
    subjectScope: declaration.subjectScope,
    resolved: true,
    requirements,
    guards,
    outcomes,
  };
}

/**
 * The production entry point. Takes no corpus, no overrides, and no options:
 * the only inputs are the authority and which bundle is being asked about, so
 * there is no argument a caller can pass to make a declared-but-inactive member
 * appear as a requirement.
 */
export async function resolveConsentBundle(
  authority: ConsentActivationAuthorityReader,
  bundleKey: ConsentBundleKey,
): Promise<ConsentBundleResolution> {
  return resolveConsentBundleAgainstCorpus(authority, bundleKey, identityConsentPolicyPublications);
}

/** Resolves one consent policy's requirement against an explicit publication record. */
export async function resolveConsentPolicyMemberAgainstPublication(
  authority: ConsentActivationAuthorityReader,
  policyKey: IdentityConsentPolicyKey,
  publication: PublicPolicyPublicationRecord,
): Promise<ConsentBundleMemberOutcome> {
  return (await resolveMember(authority, policyKey, publication)).outcome;
}

/**
 * The production per-policy entry point, for surfaces that gate on one policy
 * rather than a whole bundle. Same derivation, same authority read, no corpus
 * argument.
 */
export async function resolveConsentPolicyMember(
  authority: ConsentActivationAuthorityReader,
  policyKey: IdentityConsentPolicyKey,
): Promise<ConsentBundleMemberOutcome> {
  if (!isIdentityConsentPolicyKey(policyKey)) {
    throw new IdentityDomainError(`Consent policy key '${policyKey}' is not a recognized Identity consent policy.`);
  }
  return resolveConsentPolicyMemberAgainstPublication(
    authority,
    policyKey,
    identityConsentPolicyPublications[policyKey],
  );
}
