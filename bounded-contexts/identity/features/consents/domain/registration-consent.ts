import {
  canonicalSigningJson,
  isValidCanonicalPayloadSignatureForKeySet,
  resolveCurrentSigningSecret,
  signCanonicalPayload,
  type SigningKeySet,
} from "@chase-sets/platform-runtime/signed-payload";

/**
 * The Registration Consent Resolution: the server-minted, signed answer to
 * "what must a person agree to in order to create an identity right now, and
 * at exactly which versions".
 *
 * Identity mints it, Identity verifies it, and no other context can produce
 * one. It is the only source of the policy versions recorded as Consent when a
 * personal identity is created -- never raw client input, and never a fresh
 * resolve taken at append time.
 */
export const REGISTRATION_CONSENT_BUNDLE_KEY = "registration";

/** One ordered element of a resolution: a policy, the exact version resolved, and where it is readable. */
export type RegistrationConsentRequirement = Readonly<{
  policyKey: string;
  version: string;
  href: string;
}>;

export type RegistrationConsentResolution = Readonly<{
  bundleKey: typeof REGISTRATION_CONSENT_BUNDLE_KEY;
  requirements: readonly RegistrationConsentRequirement[];
  resolvedAt: string;
}>;

/** A resolution plus the HMAC that proves Identity minted it. */
export type SignedRegistrationConsentResolution = RegistrationConsentResolution &
  Readonly<{
    signature: string;
  }>;

/**
 * The Registration Consent Submission: the affirmation is a field OF the
 * resolution it answers, never a sibling of one the server fetched separately.
 *
 * There is deliberately no shape in which a caller hands over a bare `affirmed`
 * flag and lets the server resolve afterwards -- that shape is how an
 * affirmation ends up recorded against a version the caller was never shown.
 */
export type RegistrationConsentSubmission = Readonly<{
  resolution: SignedRegistrationConsentResolution;
  affirmed: boolean;
}>;

/**
 * How long a minted resolution stays submittable. Long enough that a person can
 * fill in a registration form, short enough that a captured resolution is not
 * an indefinite bearer token.
 */
export const REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a resolution minted by an instance whose clock runs slightly ahead. */
export const REGISTRATION_CONSENT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The single violation category for "no server-minted resolution accompanied
 * this registration".
 *
 * Absent, unparseable, unsigned, tampered, reordered, foreign-key-signed and
 * hand-authored submissions all land here, on purpose. They are one semantic
 * failure, not six syntactic ones -- a caller that reaches this code has failed
 * to bring a value only Identity can produce, and how it failed to bring one is
 * a diagnostic detail carried in `reason`, not a different rule.
 */
export const REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE = "registration_consent_not_server_minted";

/** A genuinely minted resolution that has aged out of, or not yet entered, its freshness window. */
export const REGISTRATION_CONSENT_EXPIRED_CODE = "registration_consent_expired";

/** A genuinely minted, fresh resolution carrying requirements that the submission did not affirm. */
export const REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE = "registration_consent_affirmation_required";

export const REGISTRATION_CONSENT_REJECTION_CODES = [
  REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
  REGISTRATION_CONSENT_EXPIRED_CODE,
  REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE,
] as const;

export type RegistrationConsentRejectionCode = (typeof REGISTRATION_CONSENT_REJECTION_CODES)[number];

export type RegistrationConsentRejectionReason =
  | "absent"
  | "malformed"
  | "unsigned"
  | "signature-invalid"
  | "stale"
  | "not-yet-valid"
  | "unaffirmed"
  /**
   * A genuinely minted, fresh, affirmed resolution whose ordered requirement
   * list is no longer the one the current bundle derives. It is an expiry, not
   * a forgery: the value was authentic when it was minted and the authority
   * moved underneath it, so it lands under the expiry code with its own reason
   * rather than inventing a public code for "the bundle changed".
   */
  | "superseded";

/** The message a superseded resolution reports. Part of the exact public 400 body. */
export const REGISTRATION_CONSENT_SUPERSEDED_MESSAGE =
  "The registration consent resolution no longer matches the current required bundle.";

/**
 * Whether a submitted ordered requirement list still names exactly the current
 * bundle, pairwise and in order.
 *
 * Order is contract, so this is deliberately not a set comparison: the same two
 * policies in the other order describe a different thing to agree to. `href` is
 * not compared -- it says where a version is readable, not what was agreed --
 * and a signed resolution's own signature already covers it.
 */
export function registrationConsentRequirementsAgree(
  submitted: readonly Readonly<{ policyKey: string; version: string }>[],
  current: readonly Readonly<{ policyKey: string; version: string }>[],
): boolean {
  if (submitted.length !== current.length) {
    return false;
  }

  return submitted.every(
    (requirement, index) =>
      requirement.policyKey === current[index].policyKey && requirement.version === current[index].version,
  );
}

export type RegistrationConsentRejection = Readonly<{
  code: RegistrationConsentRejectionCode;
  reason: RegistrationConsentRejectionReason;
  message: string;
}>;

export type RegistrationConsentVerification =
  | Readonly<{ ok: true; submission: RegistrationConsentSubmission }>
  | Readonly<{ ok: false; rejection: RegistrationConsentRejection }>;

export function isRegistrationConsentRejectionCode(value: unknown): value is RegistrationConsentRejectionCode {
  return REGISTRATION_CONSENT_REJECTION_CODES.includes(value as RegistrationConsentRejectionCode);
}

/**
 * The legacy static requirement corpus, retained empty.
 *
 * The mint no longer reads it: registration resolves the whole `registration`
 * Consent Bundle through `IdentityServices.registrationConsentBundles`, so
 * requirements come from published metadata paired with a validated Consent
 * Activation Authority read rather than from a literal anybody can edit. It
 * stays because it is the permanent, machine-checkable statement that no
 * requirement is smuggled in this way -- a non-empty value here would be a
 * second, unguarded source of required versions.
 *
 * Its emptiness was never a disabled mode and still is not: a resolution minted
 * over an empty requirement set is still signed, still version-bearing, still
 * carries `resolvedAt`, and is still mandatory on every first-use path. No
 * branch anywhere reads the length of a requirement list to decide whether the
 * resolution itself is required.
 */
export const REGISTRATION_CONSENT_ACTIVATABLE_POLICIES: readonly RegistrationConsentRequirement[] = [];

/** Map a requirement corpus into the ordered requirement set a resolution carries. */
export function resolveRegistrationConsentRequirements(
  corpus: readonly RegistrationConsentRequirement[] = REGISTRATION_CONSENT_ACTIVATABLE_POLICIES,
): readonly RegistrationConsentRequirement[] {
  return corpus.map((policy) => ({
    policyKey: policy.policyKey,
    version: policy.version,
    href: policy.href,
  }));
}

/**
 * The exact bytes the signature covers.
 *
 * Rebuilt field by field from the parsed resolution rather than re-serializing
 * whatever the caller sent, so a submission cannot smuggle unsigned members
 * past verification by hiding them in the payload the signature was taken over.
 * Requirement order is preserved, so a reordered array produces different bytes
 * and fails verification.
 */
function registrationConsentSigningPayload(resolution: RegistrationConsentResolution): string {
  return canonicalSigningJson({
    bundleKey: resolution.bundleKey,
    requirements: resolution.requirements.map((requirement) => ({
      policyKey: requirement.policyKey,
      version: requirement.version,
      href: requirement.href,
    })),
    resolvedAt: resolution.resolvedAt,
  });
}

export function mintRegistrationConsentResolution(
  params: Readonly<{
    requirements: readonly RegistrationConsentRequirement[];
    resolvedAt: string;
    signingKeys: SigningKeySet;
  }>,
): SignedRegistrationConsentResolution {
  const signingSecret = resolveCurrentSigningSecret(params.signingKeys);
  if (!signingSecret) {
    throw new Error("A registration consent signing key is required to mint a resolution.");
  }
  if (!isTimezoneBearingRfc3339(params.resolvedAt)) {
    throw new Error("A registration consent resolution must carry a timezone-bearing RFC3339 resolvedAt.");
  }

  const resolution: RegistrationConsentResolution = {
    bundleKey: REGISTRATION_CONSENT_BUNDLE_KEY,
    requirements: params.requirements.map((requirement) => ({
      policyKey: requirement.policyKey,
      version: requirement.version,
      href: requirement.href,
    })),
    resolvedAt: params.resolvedAt,
  };

  return {
    ...resolution,
    signature: signCanonicalPayload(registrationConsentSigningPayload(resolution), signingSecret),
  };
}

/**
 * Verify a candidate submission and, if it holds up, hand back the verified
 * value. Every rejection is decided here, before the caller has done anything.
 */
export function verifyRegistrationConsentSubmission(
  candidate: unknown,
  options: Readonly<{
    signingKeys: SigningKeySet;
    nowMs: number;
    freshnessWindowMs?: number;
    clockSkewToleranceMs?: number;
  }>,
): RegistrationConsentVerification {
  if (candidate === undefined || candidate === null) {
    return reject(
      REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
      "absent",
      "A server-minted registration consent resolution is required.",
    );
  }

  const parsed = parseRegistrationConsentSubmission(candidate);
  if (!parsed.ok) {
    return reject(REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE, parsed.reason, parsed.message);
  }

  const { resolution, affirmed, signature } = parsed;
  if (!signature) {
    return reject(
      REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
      "unsigned",
      "The registration consent resolution carries no signature.",
    );
  }

  if (
    !isValidCanonicalPayloadSignatureForKeySet(
      registrationConsentSigningPayload(resolution),
      signature,
      options.signingKeys,
    )
  ) {
    return reject(
      REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
      "signature-invalid",
      "The registration consent resolution signature does not verify.",
    );
  }

  const resolvedAtMs = Date.parse(resolution.resolvedAt);
  const freshnessWindowMs = options.freshnessWindowMs ?? REGISTRATION_CONSENT_FRESHNESS_WINDOW_MS;
  const clockSkewToleranceMs = options.clockSkewToleranceMs ?? REGISTRATION_CONSENT_CLOCK_SKEW_TOLERANCE_MS;
  if (options.nowMs - resolvedAtMs > freshnessWindowMs) {
    return reject(
      REGISTRATION_CONSENT_EXPIRED_CODE,
      "stale",
      "The registration consent resolution is older than the freshness window.",
    );
  }
  if (resolvedAtMs - options.nowMs > clockSkewToleranceMs) {
    return reject(
      REGISTRATION_CONSENT_EXPIRED_CODE,
      "not-yet-valid",
      "The registration consent resolution is dated beyond the accepted clock skew.",
    );
  }

  if (resolution.requirements.length > 0 && !affirmed) {
    return reject(
      REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE,
      "unaffirmed",
      "The registration consent resolution carries requirements that were not affirmed.",
    );
  }

  return {
    ok: true,
    submission: {
      resolution: { ...resolution, signature },
      affirmed,
    },
  };
}

function reject(
  code: RegistrationConsentRejectionCode,
  reason: RegistrationConsentRejectionReason,
  message: string,
): RegistrationConsentVerification {
  return { ok: false, rejection: { code, reason, message } };
}

type ParsedRegistrationConsentSubmission =
  | Readonly<{
      ok: true;
      resolution: RegistrationConsentResolution;
      affirmed: boolean;
      signature: string;
    }>
  | Readonly<{ ok: false; reason: "malformed" | "unsigned"; message: string }>;

/**
 * Strict, recursively closed parse. An unknown member anywhere in the
 * submission is a rejection rather than a silently ignored extra, so a shape
 * that merely resembles a submission never reaches signature verification by
 * accident.
 */
function parseRegistrationConsentSubmission(candidate: unknown): ParsedRegistrationConsentSubmission {
  if (!isPlainObject(candidate)) {
    return malformed("The registration consent submission must be an object.");
  }
  if (hasUnknownKeys(candidate, ["resolution", "affirmed"])) {
    return malformed("The registration consent submission carries unknown members.");
  }
  if (typeof candidate.affirmed !== "boolean") {
    return malformed("The registration consent submission must carry a boolean affirmation.");
  }

  const resolution = candidate.resolution;
  if (!isPlainObject(resolution)) {
    return malformed("The registration consent submission must carry a resolution object.");
  }
  if (hasUnknownKeys(resolution, ["bundleKey", "requirements", "resolvedAt", "signature"])) {
    return malformed("The registration consent resolution carries unknown members.");
  }
  if (resolution.bundleKey !== REGISTRATION_CONSENT_BUNDLE_KEY) {
    return malformed("The registration consent resolution names an unknown bundle.");
  }
  if (typeof resolution.resolvedAt !== "string" || !isTimezoneBearingRfc3339(resolution.resolvedAt)) {
    return malformed("The registration consent resolution must carry a timezone-bearing RFC3339 resolvedAt.");
  }
  if (!Array.isArray(resolution.requirements)) {
    return malformed("The registration consent resolution must carry an ordered requirement list.");
  }

  const requirements: RegistrationConsentRequirement[] = [];
  for (const entry of resolution.requirements) {
    if (!isPlainObject(entry)) {
      return malformed("Every registration consent requirement must be an object.");
    }
    if (hasUnknownKeys(entry, ["policyKey", "version", "href"])) {
      return malformed("A registration consent requirement carries unknown members.");
    }
    if (!isNonEmptyString(entry.policyKey) || !isNonEmptyString(entry.version) || !isNonEmptyString(entry.href)) {
      return malformed("Every registration consent requirement needs a policy key, version, and href.");
    }
    requirements.push({ policyKey: entry.policyKey, version: entry.version, href: entry.href });
  }

  if (resolution.signature !== undefined && typeof resolution.signature !== "string") {
    return malformed("The registration consent resolution signature must be a string.");
  }

  return {
    ok: true,
    resolution: {
      bundleKey: REGISTRATION_CONSENT_BUNDLE_KEY,
      requirements,
      resolvedAt: resolution.resolvedAt,
    },
    affirmed: candidate.affirmed,
    signature: typeof resolution.signature === "string" ? resolution.signature : "",
  };
}

function malformed(message: string): ParsedRegistrationConsentSubmission {
  return { ok: false, reason: "malformed", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

const TIMEZONE_BEARING_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `resolvedAt` must name an instant, not a wall-clock reading. A timestamp
 * without an offset would let the same string mean different instants on either
 * side of the freshness comparison.
 */
export function isTimezoneBearingRfc3339(value: string): boolean {
  return TIMEZONE_BEARING_RFC3339.test(value) && Number.isFinite(Date.parse(value));
}
