import type {
  ConsentActivationAuthoritySnapshot,
  ConsentActivationGuard,
} from "@chase-sets/platform-policy/consent-activation-authority";
import type { ConsentActivationAuthorityRuntime } from "@chase-sets/platform-policy/runtime";
import {
  publicPolicyHrefsByKey,
  publicPolicyPublicationRecords,
  publicPolicyPublicationStatuses,
  type PublicPolicyKey,
  type PublicPolicyPublicationRecord,
} from "@chase-sets/public-docs";
import { assertNever, IdentityDomainError, type ConsentSubjectType } from "../../../support/runtime-support/common";
import { TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN } from "./terms-of-service";
import { identityConsentActiveVersionPolicies, type IdentityConsentPolicyKey } from "./terms-of-service-policy";

/**
 * The Consent Bundle: the ordered set of policies one surface asks a subject to
 * agree to, and the scope the resulting Consents are recorded at.
 *
 * Two contracts live in this module and they are deliberately NOT the same one.
 *
 * 1. THE MEMBER REGISTRY is a closed, declared list. Declaring a member says
 *    only "this policy belongs to this surface's bundle". Nothing in it is a
 *    requirement, and no caller can add to it -- there is no options bag, no
 *    override, and no default that a caller can widen.
 * 2. THE REQUIREMENT SET is derived, per resolution, from two independent
 *    facts about each member: the compiled publication record says the artifact
 *    is consent-activatable, AND the member's Consent Activation Authority
 *    reports it active. A member missing either is omitted. Adding a member
 *    therefore requires nothing; only publication plus activation does.
 *
 * The empty requirement set the shipped corpus produces today is a value, not a
 * disabled mode. Nothing here reads the length of the requirement set to decide
 * whether a resolution, a guard, or the invariant applies.
 *
 * Ordering is part of the contract. The declared member order is the order
 * requirements are emitted in, because a minted registration resolution signs
 * requirement order -- reordering the list is tampering, not an equivalent
 * encoding.
 */

export const CONSENT_BUNDLE_KEYS = ["registration", "seller-onboarding"] as const;

export type ConsentBundleKey = (typeof CONSENT_BUNDLE_KEYS)[number];

export type ConsentBundleMember = Readonly<{
  /**
   * The canonical Consent policy key. It is simultaneously the Public Presence
   * publication key (which supplies publication state, version, and href) and
   * the key recorded on the Consent fact, so the document a person read and the
   * fact recorded about them can never name different policies.
   */
  policyKey: IdentityConsentPolicyKey;
}>;

/**
 * Who performs the recording. The subject records their own user-scoped
 * Consent; an account-scoped Consent is recorded by an authorized member of
 * that account, with the acting user captured alongside the account subject.
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
 * Defining it is this module's job; WIRING it -- gating listing publication on
 * whether the account has satisfied it -- is reserved for the seller-gating
 * slice (issue 5694) and does not exist at this head. Nothing in this repo
 * currently resolves or enforces this bundle on a seller surface.
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
 * True for a policy key that some bundle declares as a member. Membership is
 * what brings a key under the publication-and-activation rules; a key no bundle
 * declares (including the history-only legacy Terms of Service alias) is
 * outside them entirely.
 */
export function isConsentBundleMemberPolicyKey(policyKey: string): policyKey is IdentityConsentPolicyKey {
  return Object.prototype.hasOwnProperty.call(identityConsentActiveVersionPolicies, policyKey);
}

/** The bundles that declare `policyKey`, in declaration order. */
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

export type ConsentPublicationCorpus = Readonly<Record<PublicPolicyKey, PublicPolicyPublicationRecord>>;

/**
 * The compiled corpus this context assesses members against. Public Presence
 * owns publication; this binding is the one place Identity names that corpus,
 * so every consent path in the context reads the same build-time facts.
 */
export const identityConsentPublicationCorpus: ConsentPublicationCorpus = publicPolicyPublicationRecords;

export type ConsentBundleMemberDisposition =
  /** The compiled artifact is not consent-activatable. Declared, never required. */
  | "omitted-not-consent-activatable"
  /** Consent-activatable, but its authority does not report it active. */
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
   * was read. A member omitted for not being consent-activatable carries none,
   * because the compiled corpus cannot change inside a running process: a
   * member that is not consent-activatable now cannot become required before
   * the process is replaced, so there is no window for a guard to protect.
   */
  guard: ConsentActivationGuard | null;
  unresolvedReason: string | null;
}>;

export type ConsentBundleUnresolvedMember = Readonly<{
  policyKey: string;
  reason: string;
}>;

export type ConsentBundleResolution = Readonly<{
  bundleKey: ConsentBundleKey;
  subjectType: ConsentSubjectType;
  recordedBy: ConsentBundleRecordingAuthority;
  /** Every declared member, in declared order, with the rule that decided it. */
  members: readonly ConsentBundleMemberResolution[];
  /** The ordered requirement set. Empty is a value. */
  requirements: readonly ConsentBundleRequirement[];
  /** Authority guards for every member whose activation was read. */
  guards: readonly ConsentActivationGuard[];
  /** Members whose publication record or authority snapshot could not be trusted. */
  unresolved: readonly ConsentBundleUnresolvedMember[];
}>;

export type ConsentBundleResolutionDeps = Readonly<{
  /**
   * The compiled publication corpus. Explicit rather than defaulted: there is
   * no fallback corpus to silently resolve against, and substituting one can
   * only change how a DECLARED member is assessed -- it can never introduce a
   * member, because members come from the closed registry above.
   */
  publications: ConsentPublicationCorpus;
  /**
   * The Consent Activation Authority. `read` folds state, active version, and
   * the guard token out of one replay of the authority stream, so this module
   * never pairs a cached policy value with a separately read revision.
   */
  authority: Pick<ConsentActivationAuthorityRuntime, "read">;
}>;

const CONTENT_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMEZONE_BEARING_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MIN_INSTANT_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_INSTANT_MS = Date.parse("2200-01-01T00:00:00.000Z");

const PUBLICATION_RECORD_FIELDS = [
  "policyKey",
  "version",
  "locale",
  "href",
  "publicationStatus",
  "effectiveAt",
  "counselApprovalReference",
  "rolloutJurisdictionsOrProductLimits",
  "launchRequired",
  "contentFingerprint",
  "consentActivatable",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInstant(value: unknown): boolean {
  if (typeof value !== "string" || !TIMEZONE_BEARING_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds >= MIN_INSTANT_MS && milliseconds < MAX_INSTANT_MS;
}

type PublicationAssessment =
  | Readonly<{ kind: "consent-activatable"; version: string; href: string }>
  | Readonly<{ kind: "not-consent-activatable"; version: string }>
  | Readonly<{ kind: "malformed"; reason: string }>;

/**
 * Reads one member's publication record. `consentActivatable` is CONSUMED from
 * the compiled metadata and never recomputed here -- readiness is Public
 * Presence's to decide. The sibling fields are validated only for internal
 * consistency, so a record that claims to be consent-activatable while
 * contradicting itself is unresolved rather than trusted. Key presence is not
 * value validity: the object is closed recursively, instants must carry a zone
 * designator and fall inside explicit bounds, and every token is shape-bounded.
 */
function assessPublication(
  policyKey: IdentityConsentPolicyKey,
  corpus: ConsentPublicationCorpus,
): PublicationAssessment {
  const record: unknown = corpus[policyKey];
  if (!isPlainObject(record)) {
    return { kind: "malformed", reason: "the publication corpus carries no record for this policy" };
  }
  for (const field of Object.keys(record)) {
    if (!(PUBLICATION_RECORD_FIELDS as readonly string[]).includes(field)) {
      return { kind: "malformed", reason: `the publication record has unexpected field '${field}'` };
    }
  }
  for (const field of PUBLICATION_RECORD_FIELDS) {
    if (!(field in record)) {
      return { kind: "malformed", reason: `the publication record is missing field '${field}'` };
    }
  }
  if (record.policyKey !== policyKey) {
    return { kind: "malformed", reason: "the publication record names a different policy" };
  }
  if (typeof record.version !== "string" || !TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(record.version)) {
    return { kind: "malformed", reason: "the publication version is not a canonical consent version" };
  }
  if (record.href !== publicPolicyHrefsByKey[policyKey]) {
    return { kind: "malformed", reason: "the publication href is not this policy's canonical route" };
  }
  if (
    typeof record.publicationStatus !== "string" ||
    !(publicPolicyPublicationStatuses as readonly string[]).includes(record.publicationStatus)
  ) {
    return { kind: "malformed", reason: "the publication status is not a declared status" };
  }
  if (typeof record.locale !== "string" || record.locale.trim().length === 0) {
    return { kind: "malformed", reason: "the publication record carries no locale" };
  }
  if (typeof record.contentFingerprint !== "string" || !CONTENT_FINGERPRINT_PATTERN.test(record.contentFingerprint)) {
    return { kind: "malformed", reason: "the publication content fingerprint is not a sha256 digest" };
  }
  if (
    !Array.isArray(record.rolloutJurisdictionsOrProductLimits) ||
    record.rolloutJurisdictionsOrProductLimits.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    return { kind: "malformed", reason: "the publication rollout limits are not a list of non-empty strings" };
  }
  if (typeof record.launchRequired !== "boolean") {
    return { kind: "malformed", reason: "the publication launch-required flag is not a boolean" };
  }
  if (typeof record.consentActivatable !== "boolean") {
    return { kind: "malformed", reason: "the publication consent-activatable flag is not a boolean" };
  }

  if (!record.consentActivatable) {
    return { kind: "not-consent-activatable", version: record.version };
  }

  if (record.publicationStatus !== "published") {
    return { kind: "malformed", reason: "the record claims consent-activatable while not published" };
  }
  if (!isBoundedInstant(record.effectiveAt)) {
    return {
      kind: "malformed",
      reason: "the record claims consent-activatable without a bounded, timezone-bearing effective instant",
    };
  }
  if (typeof record.counselApprovalReference !== "string" || record.counselApprovalReference.trim().length === 0) {
    return { kind: "malformed", reason: "the record claims consent-activatable without a counsel approval reference" };
  }

  return { kind: "consent-activatable", version: record.version, href: publicPolicyHrefsByKey[policyKey] };
}

type AuthorityAssessment =
  | Readonly<{ kind: "active"; version: string }>
  | Readonly<{ kind: "not-activated" }>
  | Readonly<{ kind: "malformed"; reason: string }>;

/**
 * Reads one member's activation out of the snapshot the authority handed back.
 * Activation is aggregate state: `never-activated` and `inactive` are both
 * "not activated", and neither is inferred from the presence or absence of a
 * stream, a row, or a policy document.
 */
function assessAuthority(
  snapshot: ConsentActivationAuthoritySnapshot,
  expected: Readonly<{ activationPolicyKey: string; publicationVersion: string }>,
): AuthorityAssessment {
  if (snapshot.policyKey !== expected.activationPolicyKey) {
    return { kind: "malformed", reason: "the activation snapshot names a different policy key" };
  }
  if (snapshot.status !== "active") {
    return { kind: "not-activated" };
  }
  if (!snapshot.registered) {
    return { kind: "malformed", reason: "the activation snapshot reports active without a registration" };
  }
  if (
    typeof snapshot.activeVersion !== "string" ||
    !TERMS_OF_SERVICE_CONSENT_VERSION_PATTERN.test(snapshot.activeVersion)
  ) {
    return { kind: "malformed", reason: "the active version is not a canonical consent version" };
  }
  if (snapshot.activeVersion !== expected.publicationVersion) {
    return {
      kind: "malformed",
      reason: `the authority reports '${snapshot.activeVersion}' active while '${expected.publicationVersion}' is published`,
    };
  }

  return { kind: "active", version: snapshot.activeVersion };
}

/**
 * THE bundle resolution. Every declared member is assessed, in declared order,
 * and each one lands on exactly one disposition -- there is no early return for
 * an empty bundle and no branch that reads the requirement count.
 *
 * The publication record is consulted first because it is a build-time constant
 * and the authority read is I/O: a member the compiled corpus says is not
 * consent-activatable cannot become required while this process lives, so its
 * authority is not read and it contributes no guard. Every member that COULD
 * become required is read from the authority, whether or not it turns out to be
 * active, so an activation landing between this resolution and a later append
 * is caught by that member's guard.
 */
export async function resolveConsentBundle(
  bundle: ConsentBundle,
  deps: ConsentBundleResolutionDeps,
): Promise<ConsentBundleResolution> {
  const members: ConsentBundleMemberResolution[] = [];

  for (const member of bundle.members) {
    const activationPolicyKey = consentBundleMemberActivationPolicyKey(member.policyKey);
    const publication = assessPublication(member.policyKey, deps.publications);

    if (publication.kind === "malformed") {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "unresolved",
        publicationVersion: null,
        requirement: null,
        guard: null,
        unresolvedReason: publication.reason,
      });
      continue;
    }

    if (publication.kind === "not-consent-activatable") {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "omitted-not-consent-activatable",
        publicationVersion: publication.version,
        requirement: null,
        guard: null,
        unresolvedReason: null,
      });
      continue;
    }

    const snapshot = await deps.authority.read(activationPolicyKey);
    const activation = assessAuthority(snapshot, {
      activationPolicyKey,
      publicationVersion: publication.version,
    });

    if (activation.kind === "malformed") {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "unresolved",
        publicationVersion: publication.version,
        requirement: null,
        guard: snapshot.guard,
        unresolvedReason: activation.reason,
      });
      continue;
    }

    if (activation.kind === "not-activated") {
      members.push({
        policyKey: member.policyKey,
        activationPolicyKey,
        disposition: "omitted-not-activated",
        publicationVersion: publication.version,
        requirement: null,
        guard: snapshot.guard,
        unresolvedReason: null,
      });
      continue;
    }

    members.push({
      policyKey: member.policyKey,
      activationPolicyKey,
      disposition: "required",
      publicationVersion: publication.version,
      requirement: { policyKey: member.policyKey, version: activation.version, href: publication.href },
      guard: snapshot.guard,
      unresolvedReason: null,
    });
  }

  return {
    bundleKey: bundle.bundleKey,
    subjectType: bundle.subjectType,
    recordedBy: bundle.recordedBy,
    members,
    requirements: members.flatMap((member) => (member.requirement ? [member.requirement] : [])),
    guards: members.flatMap((member) => (member.guard ? [member.guard] : [])),
    unresolved: members.flatMap((member) =>
      member.unresolvedReason ? [{ policyKey: member.policyKey, reason: member.unresolvedReason }] : [],
    ),
  };
}

export const CONSENT_VERSION_NOT_PUBLISHED_CODE = "consent_version_not_published";
export const CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE = "consent_version_not_consent_activatable";
export const CONSENT_VERSION_NOT_ACTIVATED_CODE = "consent_version_not_activated";
export const CONSENT_SUBJECT_SCOPE_CODE = "consent_subject_scope_not_bundle_declared";
export const CONSENT_BUNDLE_UNRESOLVED_CODE = "consent_bundle_unresolved";
export const CONSENT_BUNDLE_SUPERSEDED_CODE = "consent_bundle_superseded";

export class ConsentVersionNotPublishedError extends IdentityDomainError {
  public readonly code: string = CONSENT_VERSION_NOT_PUBLISHED_CODE;

  public constructor(
    public readonly policyKey: string,
    public readonly policyVersion: string,
    reason: string,
  ) {
    super(`Consent for '${policyKey}' at version '${policyVersion}' cannot be recorded: ${reason}.`);
    this.name = "ConsentVersionNotPublishedError";
  }
}

/**
 * The publication record itself says the artifact may not be consented to yet.
 *
 * A distinct rejection from "no artifact publishes this version", and a
 * subtype of it, because the two are the same half of the admission and every
 * caller that already handles the publication rejection must keep handling
 * this one. What separates them is diagnostic and real: the version is exactly
 * the one published -- the document is simply not counsel-approved, published
 * and readiness-valid, so nothing about it can be agreed to. No amount of
 * activation authority state changes that, which is why this is decided before
 * the authority is read at all.
 */
export class ConsentVersionNotConsentActivatableError extends ConsentVersionNotPublishedError {
  public override readonly code: string = CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE;

  public constructor(policyKey: string, policyVersion: string) {
    super(policyKey, policyVersion, "its publication record is not consent-activatable");
    this.name = "ConsentVersionNotConsentActivatableError";
  }
}

/**
 * A Consent whose subject does not match the scope its bundle declares.
 *
 * The subject of a bundle member's Consent is not the caller's to choose. It
 * follows from the bundle declaration (issue 5680: registration is user-scoped,
 * seller-onboarding is account-scoped and recorded by an authorized account
 * member), so a caller cannot record a user bundle's policy against an account
 * -- their own or anyone else's -- nor an account bundle's policy against a
 * user.
 */
export class ConsentSubjectScopeError extends IdentityDomainError {
  public readonly code: string = CONSENT_SUBJECT_SCOPE_CODE;

  public constructor(
    public readonly policyKey: string,
    reason: string,
  ) {
    super(`Consent for '${policyKey}' cannot be recorded: ${reason}.`);
    this.name = "ConsentSubjectScopeError";
  }
}

export class ConsentVersionNotActivatedError extends IdentityDomainError {
  public readonly code = CONSENT_VERSION_NOT_ACTIVATED_CODE;

  public constructor(
    public readonly policyKey: string,
    public readonly policyVersion: string,
    public readonly activationStatus: string,
    public readonly activeVersion: string | null,
  ) {
    super(
      `Consent for '${policyKey}' at version '${policyVersion}' cannot be recorded: its activation authority reports ${activationStatus}${
        activeVersion === null ? "" : ` at version '${activeVersion}'`
      }.`,
    );
    this.name = "ConsentVersionNotActivatedError";
  }
}

export type ConsentRecordingPublicationAdmission =
  /** A bundle member whose publication record admits recording at this version. */
  | Readonly<{ kind: "admitted" }>
  /** No bundle declares this key, so bundle publication rules do not reach it. */
  | Readonly<{ kind: "outside-bundle-rules" }>
  | Readonly<{ kind: "version-mismatch"; publishedVersion: string }>
  | Readonly<{ kind: "not-consent-activatable"; publishedVersion: string }>
  | Readonly<{ kind: "malformed"; reason: string }>;

/**
 * The publication half of the recording admission, as a decision rather than a
 * throw, and a pure function of the compiled corpus.
 *
 * TWO independent publication facts must both hold for a bundle member:
 *
 * 1. The record names the EXACT version being recorded. An invented, stub, or
 *    superseded version never gets past this, and neither does a member whose
 *    publication record cannot be trusted.
 * 2. That record is CONSENT-ACTIVATABLE. `consentActivatable` is Public
 *    Presence's compiled statement that the artifact is published,
 *    counsel-approved and readiness-valid -- that there is something a person
 *    could have read and agreed to. A record that says no is not a version
 *    problem and cannot be turned into one by the activation authority: the
 *    authority stream is a SEPARATE fact about a separate aggregate, and an
 *    operator who activates a key whose artifact is still a placeholder has
 *    activated nothing anyone can consent to. Admission therefore requires both
 *    halves, and decides this one BEFORE any authority is read or written.
 *
 * A policy key no bundle declares is out of scope here entirely -- the
 * history-only legacy Terms of Service alias and any non-bundle key keep
 * recording exactly as before, because bundle membership is what brings a key
 * under bundle rules.
 */
export function assessConsentRecordingPublication(
  policyKey: string,
  policyVersion: string,
  corpus: ConsentPublicationCorpus,
): ConsentRecordingPublicationAdmission {
  if (!isConsentBundleMemberPolicyKey(policyKey)) {
    return { kind: "outside-bundle-rules" };
  }

  const publication = assessPublication(policyKey, corpus);
  if (publication.kind === "malformed") {
    return { kind: "malformed", reason: publication.reason };
  }
  if (publication.version !== policyVersion) {
    return { kind: "version-mismatch", publishedVersion: publication.version };
  }
  if (publication.kind === "not-consent-activatable") {
    return { kind: "not-consent-activatable", publishedVersion: publication.version };
  }

  return { kind: "admitted" };
}

/** The publication half of the recording admission, asserted. */
export function assertConsentVersionIsPublished(
  policyKey: string,
  policyVersion: string,
  corpus: ConsentPublicationCorpus,
): void {
  const admission = assessConsentRecordingPublication(policyKey, policyVersion, corpus);
  switch (admission.kind) {
    case "admitted":
    case "outside-bundle-rules":
      return;
    case "malformed":
      throw new ConsentVersionNotPublishedError(policyKey, policyVersion, admission.reason);
    case "version-mismatch":
      throw new ConsentVersionNotPublishedError(
        policyKey,
        policyVersion,
        `the published version is '${admission.publishedVersion}'`,
      );
    case "not-consent-activatable":
      throw new ConsentVersionNotConsentActivatableError(policyKey, policyVersion);
    default:
      return assertNever(admission);
  }
}

/**
 * The same rule, asked instead of thrown, for provisioning paths.
 *
 * Seed, bootstrap and fixture profiles use this to decide whether to author a
 * Consent fact at all. They deliberately consult the admission rather than
 * carrying their own copy of it: a provisioning path that "knows" the corpus is
 * activatable is exactly how a false corpus ends up with recorded Consents.
 */
export function isConsentRecordingPublicationAdmitted(
  policyKey: string,
  policyVersion: string,
  corpus: ConsentPublicationCorpus,
): boolean {
  const { kind } = assessConsentRecordingPublication(policyKey, policyVersion, corpus);
  return kind === "admitted" || kind === "outside-bundle-rules";
}

function isExactSubjectId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type ConsentBundleMemberSubjectScope = Readonly<{
  subjectType: ConsentSubjectType;
  recordedBy: ConsentBundleRecordingAuthority;
  /** The declaring bundles this scope was read from, in declaration order. */
  bundleKeys: readonly ConsentBundleKey[];
}>;

/**
 * The subject scope a bundle member's Consent must be recorded at, or null for
 * a key no bundle declares.
 *
 * Read from the declarations rather than restated, so the scope a Consent is
 * recorded at and the scope its bundle is resolved at cannot drift apart. If a
 * key were ever declared by two bundles that disagree on scope, there is no one
 * subject its Consent belongs to; that fails closed here rather than picking
 * the first declaration.
 */
export function consentBundleMemberSubjectScope(policyKey: string): ConsentBundleMemberSubjectScope | null {
  const bundleKeys = consentBundlesDeclaring(policyKey);
  if (bundleKeys.length === 0) {
    return null;
  }

  const declared = bundleKeys.map((bundleKey) => consentBundles[bundleKey]);
  const [first] = declared;
  if (declared.some((bundle) => bundle.subjectType !== first.subjectType || bundle.recordedBy !== first.recordedBy)) {
    throw new ConsentSubjectScopeError(policyKey, "its declaring bundles do not agree on one subject scope");
  }

  return { subjectType: first.subjectType, recordedBy: first.recordedBy, bundleKeys };
}

export type ConsentRecordingSubject = Readonly<{
  subjectType: ConsentSubjectType;
  userId?: string | null;
  accountId?: string | null;
}>;

/**
 * The subject half of the recording admission: pure, so it holds on every path
 * into the decider, and decided before anything reads or writes the activation
 * authority.
 *
 * A Consent for a bundle member is recorded at the scope its bundle declares
 * and for the exact identity at that scope -- never at a scope the caller
 * picked. The failure this closes is not hypothetical: a user-scoped bundle's
 * policy recorded as `subjectType: "account"` produces a fact whose subject is
 * an account the recording person may have nothing to do with, and it reads as
 * that account's acceptance forever after.
 *
 * An account-scoped member additionally has to capture the acting member,
 * because issue 5680 decided such a Consent is recorded BY an authorized
 * account member FOR the account. Which members are authorized is membership
 * state and belongs to the seller-gating slice (issue 5694) wiring this; what
 * is enforced here is that the account subject is exact and an acting member is
 * always carried, so no account-scoped Consent can be anonymous.
 *
 * The companion identity a user-scoped Consent carries -- the account the
 * person was acting in -- stays recorded context, not the subject. The
 * projection keys the fact on `(subject_type, subject_id)`, and for a
 * user-scoped Consent `subject_id` is the user.
 */
export function assertConsentSubjectMatchesBundle(policyKey: string, subject: ConsentRecordingSubject): void {
  const scope = consentBundleMemberSubjectScope(policyKey);
  if (scope === null) {
    return;
  }

  if (subject.subjectType !== scope.subjectType) {
    throw new ConsentSubjectScopeError(
      policyKey,
      `its bundle records a ${scope.subjectType}-scoped subject and this recording names a ${subject.subjectType}-scoped one`,
    );
  }

  if (scope.subjectType === "user") {
    if (!isExactSubjectId(subject.userId)) {
      throw new ConsentSubjectScopeError(policyKey, "a user-scoped bundle member must name the exact user it is for");
    }
    return;
  }

  if (!isExactSubjectId(subject.accountId)) {
    throw new ConsentSubjectScopeError(
      policyKey,
      "an account-scoped bundle member must name the exact account it is for",
    );
  }
  if (scope.recordedBy === "authorized-account-member" && !isExactSubjectId(subject.userId)) {
    throw new ConsentSubjectScopeError(
      policyKey,
      "an account-scoped bundle member must capture the acting account member recording it",
    );
  }
}

export type ConsentAcceptanceSubject = Readonly<{ subjectType: ConsentSubjectType; subjectId: string }>;

/**
 * The exact subject a bundle's acceptance is resolved for.
 *
 * The bundle declares the subject TYPE; the caller supplies identities, and
 * exactly the one the bundle declares is used. There is deliberately no
 * fallback to the other identity: resolving a user bundle by "or this account"
 * is what lets one member of a shared account satisfy another member's
 * requirement. Null means the caller did not supply the identity this bundle is
 * about, which reads as "not accepted" rather than as a wider search.
 */
export function consentBundleAcceptanceSubject(
  bundle: ConsentBundle,
  subject: Readonly<{ userId?: string | null; accountId?: string | null }>,
): ConsentAcceptanceSubject | null {
  const subjectId = bundle.subjectType === "user" ? subject.userId : subject.accountId;
  return isExactSubjectId(subjectId) ? { subjectType: bundle.subjectType, subjectId } : null;
}

/**
 * The activation half of the recording admission. Activation is decided from
 * the authority's aggregate state, never from the presence of a stream, a
 * projection row, or a policy document -- and the version compared here is the
 * one folded out of the same replay that produced the state beside it.
 */
export function assertConsentVersionIsActivated(
  policyKey: string,
  policyVersion: string,
  snapshot: ConsentActivationAuthoritySnapshot,
): void {
  if (snapshot.status !== "active" || snapshot.activeVersion !== policyVersion) {
    throw new ConsentVersionNotActivatedError(policyKey, policyVersion, snapshot.status, snapshot.activeVersion);
  }
}

/**
 * A bundle whose members could not all be assessed. Every unresolved member is
 * carried, so a caller reports the exact set rather than falling back to a
 * partial answer or an invented default.
 */
export class ConsentBundleUnresolvedError extends IdentityDomainError {
  public readonly code = CONSENT_BUNDLE_UNRESOLVED_CODE;

  public constructor(
    public readonly bundleKey: ConsentBundleKey,
    public readonly unresolved: readonly ConsentBundleUnresolvedMember[],
  ) {
    super(
      `Consent bundle '${bundleKey}' could not be resolved: ${unresolved
        .map((member) => `${member.policyKey} (${member.reason})`)
        .join("; ")}.`,
    );
    this.name = "ConsentBundleUnresolvedError";
  }
}

export function assertConsentBundleResolved(resolution: ConsentBundleResolution): void {
  if (resolution.unresolved.length > 0) {
    throw new ConsentBundleUnresolvedError(resolution.bundleKey, resolution.unresolved);
  }
}

/**
 * A previously minted, genuinely signed resolution that no longer covers what
 * the bundle currently requires -- an activation landed between the mint and
 * this append. Distinct from every rejection the minted-resolution transport
 * defines: the value is authentic, the world moved.
 */
export class ConsentBundleSupersededError extends IdentityDomainError {
  public readonly code = CONSENT_BUNDLE_SUPERSEDED_CODE;

  public constructor(
    public readonly bundleKey: ConsentBundleKey,
    public readonly missing: readonly ConsentBundleRequirement[],
  ) {
    super(
      `Consent bundle '${bundleKey}' now requires ${missing
        .map((requirement) => `${requirement.policyKey}@${requirement.version}`)
        .join(", ")}, which the submitted resolution does not carry.`,
    );
    this.name = "ConsentBundleSupersededError";
  }
}

function sameRequirement(left: ConsentBundleRequirement, right: ConsentBundleRequirement): boolean {
  return left.policyKey === right.policyKey && left.version === right.version && left.href === right.href;
}

/**
 * Binds an already-affirmed requirement list to the bundle as it stands now.
 *
 * This validates; it never re-resolves. The versions recorded as Consent still
 * come from the affirmed list, never from this resolution -- resolving a version
 * at append time is exactly how an acceptance ends up recorded against a version
 * the affirming client never saw. What this rejects is the opposite failure:
 * appending against a bundle that has grown since the list was affirmed.
 *
 * Every currently required member must appear in the affirmed list with the
 * same key, version, and href, in the bundle's declared relative order. An
 * affirmed entry the bundle no longer requires is not rejected here -- it is a
 * genuinely affirmed Consent, and whether it is still recordable is decided by
 * the recording admission rules, not by this comparison.
 */
export function assertAffirmedRequirementsCoverBundle(
  resolution: ConsentBundleResolution,
  affirmed: readonly ConsentBundleRequirement[],
): void {
  assertConsentBundleResolved(resolution);

  const missing: ConsentBundleRequirement[] = [];
  let searchFrom = 0;
  for (const requirement of resolution.requirements) {
    const index = affirmed.findIndex(
      (candidate, position) => position >= searchFrom && sameRequirement(candidate, requirement),
    );
    if (index === -1) {
      missing.push(requirement);
      continue;
    }
    searchFrom = index + 1;
  }

  if (missing.length > 0) {
    throw new ConsentBundleSupersededError(resolution.bundleKey, missing);
  }
}
