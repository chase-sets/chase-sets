import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { AccountId, ConsentId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { normalizeEmail, normalizePhoneNumber } from "./common";

/**
 * The Registration Operation: the server-derived identity of one attempt to
 * create a personal identity for one verified contact.
 *
 * It exists so that registration is idempotent as well as atomic. Atomicity
 * alone still leaves a retry blocked by the display-name reservation the failed
 * attempt wrote, and it still lets two concurrent attempts for the same person
 * mint two accounts. The operation key is what makes "the same registration,
 * again" a thing the server can recognize.
 *
 * It is derived inside Identity from the normalized verified contact every
 * caller already supplies, and never from the registration consent submission:
 * the submission's signed payload covers only the bundle key, the requirements
 * and `resolvedAt`, so over an empty corpus two unrelated registrations minted
 * in the same second produce identical bytes, and deriving identity from it
 * would fuse two different people onto one account.
 */
export const REGISTRATION_OPERATION_KEY_NAMESPACE = "identity.registration-operation";

/**
 * Bumping this version deliberately re-partitions the operation space: every
 * in-flight operation under the previous version stops converging with a new
 * one for the same contact. It is part of the key bytes so that a future change
 * to normalization can never silently re-point an existing claim.
 */
export const REGISTRATION_OPERATION_KEY_VERSION = "v1";

/**
 * Command-side only. This prefix must never join a projection group: enrolling
 * it would put the claim under a truncate-owned-tables reset strategy, and a
 * reset would then destroy the convergence anchor for every registration.
 */
export const REGISTRATION_OPERATION_STREAM_PREFIX = "identity.registration-operation-";

export const REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE = "identity.registration-operation.claimed";

const REGISTRATION_STREAM_READ_PAGE_SIZE = 500;

export type RegistrationOperationContactType = "email" | "phone";

export type RegistrationOperation = Readonly<{
  /** The namespaced, versioned key bytes. Carries the contact, so it is never logged or published. */
  key: string;
  /** The publishable digest of `key`. This is what the claim event records. */
  keyDigest: string;
  contactType: RegistrationOperationContactType;
  contactValue: string;
  streamId: string;
}>;

export type RegistrationOperationConsent = Readonly<{
  consentId: ConsentId;
  policyKey: string;
  policyVersion: string;
}>;

/**
 * The claim: the winning attempt's ids, recorded once per operation.
 *
 * Deliberately carries no raw contact. The account and user streams already
 * hold the address the person registered with; the claim only has to be able to
 * answer "which ids did this operation settle on", so it records the digest.
 */
export type RegistrationOperationClaim = Readonly<{
  operationKeyDigest: string;
  operationKeyVersion: string;
  contactType: RegistrationOperationContactType;
  accountId: AccountId;
  userId: UserId;
  membershipId: MembershipId;
  displayName: string;
  displayNameKey: string;
  consents: readonly RegistrationOperationConsent[];
  claimedAt: string;
}>;

export type ReadRegistrationOperationClaim = Readonly<{
  version: number;
  claim: RegistrationOperationClaim;
}>;

/**
 * The claim stream is the authority for every participant id used during
 * recovery. A malformed or contradictory history must therefore be
 * distinguishable from an operation that has never been claimed.
 */
export class RegistrationOperationClaimHistoryError extends Error {
  constructor() {
    super("The registration operation claim history is invalid.");
    this.name = "RegistrationOperationClaimHistoryError";
  }
}

/**
 * Exactly one of email or phone is present on every production registration
 * path, and both are pre-checked against a projection by their caller before
 * registration is attempted -- so one-identity-per-verified-contact is already
 * the intent. Deriving the operation from it is what makes that intent
 * race-free rather than merely likely.
 *
 * Email wins when both are supplied. That tie-break is fixed rather than
 * situational because the alternative -- letting the pair decide -- would make
 * the same person's email-only retry a different operation from their
 * email-and-phone first attempt, and the retry would mint a second account.
 */
export function deriveRegistrationOperation(
  params: Readonly<{ email?: string | null; phone?: string | null }>,
): RegistrationOperation | null {
  const email = normalizeEmail(params.email ?? "");
  const phone = normalizePhoneNumber(params.phone ?? "");
  const contactType: RegistrationOperationContactType | null = email ? "email" : phone ? "phone" : null;
  if (!contactType) {
    return null;
  }

  const contactValue = contactType === "email" ? email : phone;
  const key = [
    REGISTRATION_OPERATION_KEY_NAMESPACE,
    REGISTRATION_OPERATION_KEY_VERSION,
    contactType,
    contactValue,
  ].join(":");
  const keyDigest = createHash("sha256").update(key, "utf8").digest("hex");

  return {
    key,
    keyDigest,
    contactType,
    contactValue,
    streamId: `${REGISTRATION_OPERATION_STREAM_PREFIX}${keyDigest}`,
  };
}

export async function readRegistrationOperationClaim(
  eventStore: EventStore,
  operation: RegistrationOperation,
): Promise<ReadRegistrationOperationClaim | null> {
  const storedEvents = await readCompleteRegistrationStreamHistory(eventStore, operation.streamId);
  if (storedEvents.length === 0) {
    return null;
  }

  const claimEvent = storedEvents[0];
  if (
    storedEvents.length !== 1 ||
    !claimEvent ||
    claimEvent.streamVersion !== 1 ||
    claimEvent.eventType !== REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE
  ) {
    throw new RegistrationOperationClaimHistoryError();
  }

  const claim = parseRegistrationOperationClaim(claimEvent.payload);
  if (
    claim.operationKeyDigest !== operation.keyDigest ||
    claim.operationKeyVersion !== REGISTRATION_OPERATION_KEY_VERSION ||
    claim.contactType !== operation.contactType
  ) {
    throw new RegistrationOperationClaimHistoryError();
  }

  return {
    version: claimEvent.streamVersion,
    claim,
  };
}

export async function readCompleteRegistrationStreamHistory(
  eventStore: EventStore,
  streamId: string,
): Promise<readonly StoredEvent[]> {
  const storedEvents: StoredEvent[] = [];
  let fromVersion = 1;

  for (;;) {
    const page = await eventStore.readStream({
      streamId,
      fromVersion,
      limit: REGISTRATION_STREAM_READ_PAGE_SIZE,
    });
    storedEvents.push(...page);

    if (page.length < REGISTRATION_STREAM_READ_PAGE_SIZE) {
      return storedEvents;
    }

    fromVersion = page[page.length - 1].streamVersion + 1;
  }
}

export function normalizeRegistrationDisplayNameKey(displayName: string): string {
  return displayName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function parseRegistrationOperationClaim(payload: unknown): RegistrationOperationClaim {
  if (!isRecord(payload)) {
    throw new RegistrationOperationClaimHistoryError();
  }

  const operationKeyDigest = requiredString(payload.operationKeyDigest);
  const operationKeyVersion = requiredString(payload.operationKeyVersion);
  const contactType = payload.contactType;
  const accountId = requiredString(payload.accountId);
  const userId = requiredString(payload.userId);
  const membershipId = requiredString(payload.membershipId);
  const displayName = requiredString(payload.displayName);
  const displayNameKey = requiredString(payload.displayNameKey);
  const claimedAt = requiredString(payload.claimedAt);
  if (
    (contactType !== "email" && contactType !== "phone") ||
    displayNameKey !== normalizeRegistrationDisplayNameKey(displayName) ||
    !Number.isFinite(Date.parse(claimedAt)) ||
    !Array.isArray(payload.consents)
  ) {
    throw new RegistrationOperationClaimHistoryError();
  }

  const consents = payload.consents.map((value) => {
    if (!isRecord(value)) {
      throw new RegistrationOperationClaimHistoryError();
    }
    return {
      consentId: requiredString(value.consentId) as ConsentId,
      policyKey: requiredString(value.policyKey),
      policyVersion: requiredString(value.policyVersion),
    };
  });
  if (new Set(consents.map((consent) => consent.consentId)).size !== consents.length) {
    throw new RegistrationOperationClaimHistoryError();
  }

  return {
    operationKeyDigest,
    operationKeyVersion,
    contactType,
    accountId: accountId as AccountId,
    userId: userId as UserId,
    membershipId: membershipId as MembershipId,
    displayName,
    displayNameKey,
    consents,
    claimedAt,
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RegistrationOperationClaimHistoryError();
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a recovering request may complete an already-claimed operation.
 *
 * A claim records the exact ordered policy versions the winning attempt was
 * shown. If the recovering request carries a different bundle, completing it
 * would append consent at versions nobody in this operation ever affirmed, so
 * the caller fails closed instead. Reconciling a genuine version disagreement
 * is activation-authority work and is owned elsewhere.
 */
export function registrationOperationConsentBundleAgrees(
  claim: RegistrationOperationClaim,
  requirements: readonly Readonly<{ policyKey: string; version: string }>[],
): boolean {
  if (claim.consents.length !== requirements.length) {
    return false;
  }

  return claim.consents.every(
    (consent, index) =>
      consent.policyKey === requirements[index].policyKey && consent.policyVersion === requirements[index].version,
  );
}
