import {
  ConsentActivationAuthorityError,
  type ValidatedConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationGuard,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityRuntime } from "@chase-sets/platform-policy/runtime";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { IDENTITY_BOOTSTRAP_ACCOUNT_ID, IDENTITY_BOOTSTRAP_USER_ID } from "../../memberships/read-model/constants";
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
 * Terms recording consumes an issued member through the provenance gate below;
 * read-side callers retain the outcome-only API.
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
export const consentBundleDeclarations = Object.freeze({
  registration: Object.freeze({
    bundleKey: "registration",
    subjectScope: "user",
    members: Object.freeze(["terms-of-service", "privacy-policy"] as const),
  }),
  "seller-onboarding": Object.freeze({
    bundleKey: "seller-onboarding",
    subjectScope: "account",
    members: Object.freeze(["seller-agreement", "payments-terms"] as const),
  }),
} as const satisfies Readonly<Record<ConsentBundleKey, ConsentBundleDeclaration>>);

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

declare const registrationDeclarationBrand: unique symbol;
declare const boundRegistrationDeclarationBrand: unique symbol;

export type RegistrationConsentDeclaration = Extract<ConsentBundleResolution, { resolved: true }> &
  Readonly<{
    bundleKey: "registration";
    subjectScope: "user";
    [registrationDeclarationBrand]: true;
  }>;

export type RegistrationConsentSubject = Readonly<{ userId: UserId; accountId: AccountId }>;

export type BoundRegistrationConsentDeclaration = Readonly<{
  declaration: RegistrationConsentDeclaration;
  subject: RegistrationConsentSubject;
  [boundRegistrationDeclarationBrand]: true;
}>;

export type RegistrationConsentBundles = Readonly<{
  resolve(): Promise<RegistrationConsentDeclaration>;
  forRegistration(subject: RegistrationConsentSubject): Promise<BoundRegistrationConsentDeclaration>;
}>;

export class RegistrationConsentBundleUnresolvedError extends Error {
  constructor() {
    super("Registration requires an issued canonical consent declaration bound to its registering subject.");
    this.name = "RegistrationConsentBundleUnresolvedError";
  }
}

const issuedRegistrationDeclarations = new WeakSet<object>();
const issuedBoundRegistrationDeclarations = new WeakSet<object>();

export function assertRegistrationConsentDeclaration(value: unknown): asserts value is RegistrationConsentDeclaration {
if (typeof value !== "object" || value === null || !issuedRegistrationDeclarations.has(value)) {
    throw new RegistrationConsentBundleUnresolvedError();
  }
}

export function bindRegistrationConsentSubject(
  declaration: RegistrationConsentDeclaration,
  subject: RegistrationConsentSubject,
): BoundRegistrationConsentDeclaration {
  assertRegistrationConsentDeclaration(declaration);
  if (
    !subject ||
    typeof subject.userId !== "string" ||
    !/^usr_[A-Za-z0-9_-]{1,80}$/.test(subject.userId) ||
    typeof subject.accountId !== "string" ||
    !/^acc_[A-Za-z0-9_-]{1,80}$/.test(subject.accountId) ||
    subject.userId === "usr_guest_checkout" ||
    subject.userId === IDENTITY_BOOTSTRAP_USER_ID ||
    subject.accountId === IDENTITY_BOOTSTRAP_ACCOUNT_ID
  ) {
    throw new RegistrationConsentBundleUnresolvedError();
  }
  const bound = Object.freeze({
    declaration,
    subject: Object.freeze({ userId: subject.userId, accountId: subject.accountId }),
  });
  issuedBoundRegistrationDeclarations.add(bound);
  return bound as BoundRegistrationConsentDeclaration;
}

export function assertBoundRegistrationConsentDeclaration(
  value: unknown,
  expected: RegistrationConsentSubject,
): asserts value is BoundRegistrationConsentDeclaration {
  if (typeof value !== "object" || value === null || !issuedBoundRegistrationDeclarations.has(value)) {
    throw new RegistrationConsentBundleUnresolvedError();
  }
  const bound = value as BoundRegistrationConsentDeclaration;
  if (bound.subject.userId !== expected.userId || bound.subject.accountId !== expected.accountId) {
    throw new RegistrationConsentBundleUnresolvedError();
  }
}

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

declare const resolvedMemberBrand: unique symbol;
export type ResolvedMemberProvenance = Readonly<{
  outcome: Extract<ConsentBundleMemberOutcome, { kind: "required" }>;
  guard: ConsentActivationGuardBinding;
  [resolvedMemberBrand]: true;
}>;

const issuedMembers = new WeakMap<object, ResolvedMember>();

export function assertResolvedMemberProvenance(
  value: unknown,
  expectedPolicyKey: IdentityConsentPolicyKey,
): asserts value is ResolvedMemberProvenance {
  const member = typeof value === "object" && value !== null ? issuedMembers.get(value) : undefined;
  if (
    !member ||
    member.outcome.policyKey !== expectedPolicyKey ||
    member.outcome.kind !== "required" ||
    !member.guard
  ) {
    throw new IdentityDomainError(
      `Consent policy '${expectedPolicyKey}' requires an issued, active member at its published version.`,
    );
  }
}

function issueResolvedMember(
  outcome: ConsentBundleMemberOutcome,
  guard: ConsentActivationGuardBinding | null,
): ResolvedMember {
  if (outcome.kind === "required") Object.freeze(outcome.requirement);
  const member = Object.freeze({
    outcome: Object.freeze(outcome),
    guard: guard === null ? null : Object.freeze(guard),
  });
  issuedMembers.set(member, member);
  return member;
}

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
    return issueResolvedMember({ kind: "publication-ineligible", policyKey }, null);
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
      return issueResolvedMember({ kind: "unresolved", policyKey, reason: "authority-unreadable" }, null);
    }
    throw error;
  }

  Object.freeze(snapshot.guard);
  return issueResolvedMember(deriveActivatedConsentMemberOutcome(policyKey, publication, snapshot), {
    policyKey,
    activeVersionPolicyKey,
    guard: snapshot.guard,
  });
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
      return Object.freeze({
        bundleKey: declaration.bundleKey,
        subjectScope: declaration.subjectScope,
        resolved: false,
        unresolvedPolicyKey: outcome.policyKey,
        unresolvedReason: outcome.reason,
        guards: Object.freeze(guards),
      });
    }

    outcomes.push(outcome);
    if (outcome.kind === "required") {
      requirements.push(outcome.requirement);
    }
  }

  const resolution = Object.freeze({
    bundleKey: declaration.bundleKey,
    subjectScope: declaration.subjectScope,
    resolved: true as const,
    requirements: Object.freeze(requirements),
    guards: Object.freeze(guards),
    outcomes: Object.freeze(outcomes),
  });
if (bundleKey === "registration") issuedRegistrationDeclarations.add(resolution);
  return resolution;
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

/** Test-only publication override; production recording uses the canonical resolver below. */
export async function resolveConsentPolicyMemberWithProvenanceAgainstPublication(
  authority: ConsentActivationAuthorityReader,
  policyKey: IdentityConsentPolicyKey,
  publication: PublicPolicyPublicationRecord,
): Promise<ResolvedMember> {
  return resolveMember(authority, policyKey, publication);
}

export async function resolveConsentPolicyMemberWithProvenance(
  authority: ConsentActivationAuthorityReader,
  policyKey: IdentityConsentPolicyKey,
): Promise<ResolvedMember> {
  if (!isIdentityConsentPolicyKey(policyKey)) {
    throw new IdentityDomainError(`Consent policy key '${policyKey}' is not a recognized Identity consent policy.`);
  }
  return resolveMember(authority, policyKey, identityConsentPolicyPublications[policyKey]);
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
  return (await resolveConsentPolicyMemberWithProvenance(authority, policyKey)).outcome;
}
