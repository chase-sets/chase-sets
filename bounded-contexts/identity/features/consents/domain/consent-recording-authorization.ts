import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { IDENTITY_BOOTSTRAP_ACCOUNT_ID, IDENTITY_BOOTSTRAP_USER_ID } from "../../memberships/read-model/constants";
import type { ConsentCommand, ConsentState, RecordConsentCommand } from "./domain";

export type ConsentRecordingAuthorizationErrorCode =
  | "consent_account_not_authorized"
  | "consent_acting_user_not_authorized"
  | "consent_authorization_context_mismatch"
  | "consent_authorization_malformed"
  | "consent_authorization_untrusted"
  | "consent_bootstrap_authorization_required"
  | "consent_provisioning_subject_mismatch"
  | "consent_registration_subject_mismatch"
  | "consent_shared_principal_forbidden"
  | "consent_subject_invalid"
  | "consent_user_not_authorized";

export class ConsentRecordingAuthorizationError extends Error {
  public constructor(
    public readonly code: ConsentRecordingAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConsentRecordingAuthorizationError";
  }
}

type ConsentAuthorizationKind = "authorized-actor" | "provisioning" | "self-registration";

type ConsentAuthorizationSubject = Readonly<{
  userId: UserId;
  accountId: AccountId;
}>;

declare const consentRecordingAuthorizationBrand: unique symbol;

export type ConsentRecordingAuthorization = Readonly<{
  kind: ConsentAuthorizationKind;
  subject: ConsentAuthorizationSubject;
  [consentRecordingAuthorizationBrand]: true;
}>;

const issuedAuthorizations = new WeakSet<object>();
const authorizationKinds = new Set<ConsentAuthorizationKind>(["authorized-actor", "provisioning", "self-registration"]);
const sharedUserIds = new Set<string>(["usr_guest_checkout", IDENTITY_BOOTSTRAP_USER_ID]);
const sharedAccountIds = new Set<string>([IDENTITY_BOOTSTRAP_ACCOUNT_ID]);

export function authorizeConsentForActor(context: EventStoreContext): ConsentRecordingAuthorization {
  const userId = requireIdentifier(context.audit.performedByUserId, "usr", "authorization actor user");
  const accountId = requireIdentifier(context.audit.forAccountId, "acc", "authorization actor account");
  return issueAuthorization("authorized-actor", userId, accountId);
}

export function authorizeConsentForSelfRegistration(
  userId: UserId,
  accountId: AccountId,
): ConsentRecordingAuthorization {
  return issueAuthorization("self-registration", userId, accountId);
}

export function authorizeConsentForProvisioning(userId: UserId, accountId: AccountId): ConsentRecordingAuthorization {
  return issueAuthorization("provisioning", userId, accountId);
}

export function assertConsentAuthorizationForContext(
  authorizationValue: unknown,
  context: EventStoreContext,
): asserts authorizationValue is ConsentRecordingAuthorization {
  const authorization = requireIssuedAuthorization(authorizationValue);

  if (authorization.kind === "authorized-actor") {
    const auditUserId = requireIdentifier(context.audit.performedByUserId, "usr", "audit user");
    const auditAccountId = requireIdentifier(context.audit.forAccountId, "acc", "audit account");
    if (authorization.subject.userId !== auditUserId || authorization.subject.accountId !== auditAccountId) {
      throw new ConsentRecordingAuthorizationError(
        "consent_authorization_context_mismatch",
        "Consent authorization does not match the authoritative request audit identity.",
      );
    }
    return;
  }

  if (
    context.audit.performedByUserId !== IDENTITY_BOOTSTRAP_USER_ID ||
    context.audit.forAccountId !== IDENTITY_BOOTSTRAP_ACCOUNT_ID
  ) {
    throw new ConsentRecordingAuthorizationError(
      "consent_bootstrap_authorization_required",
      "Consent self-registration and provisioning authorization require the Identity bootstrap principal.",
    );
  }
}

export function assertConsentRecordAuthorization(
  command: RecordConsentCommand,
  authorization: ConsentRecordingAuthorization,
): void {
  assertCommandSubjectIsValid(command);
  assertSubjectIsNotShared(command.userId ?? null, command.accountId ?? null);

  if (authorization.kind === "self-registration") {
    if (
      command.subjectType !== "user" ||
      command.userId !== authorization.subject.userId ||
      command.accountId !== authorization.subject.accountId
    ) {
      throw new ConsentRecordingAuthorizationError(
        "consent_registration_subject_mismatch",
        "Registration Consent must name the User and Account created by this registration.",
      );
    }
    return;
  }

  if (authorization.kind === "provisioning") {
    if (command.userId !== authorization.subject.userId || command.accountId !== authorization.subject.accountId) {
      throw new ConsentRecordingAuthorizationError(
        "consent_provisioning_subject_mismatch",
        "Provisioned Consent must name the User and Account selected by the provisioning caller.",
      );
    }
    return;
  }

  assertActorSubjectMatches(
    command.subjectType,
    command.userId ?? null,
    command.accountId ?? null,
    authorization.subject,
  );
}

export function assertConsentCommandAuthorization(
  state: ConsentState,
  command: ConsentCommand,
  authorization: ConsentRecordingAuthorization,
): void {
  if (command.type === "RecordConsent") {
    assertConsentRecordAuthorization(command, authorization);
    return;
  }

  if (state.id === null || state.subjectType === null) {
    return;
  }

  assertSubjectIsNotShared(state.userId, state.accountId);
  if (authorization.kind === "self-registration") {
    throw new ConsentRecordingAuthorizationError(
      "consent_registration_subject_mismatch",
      "Self-registration authorization cannot withdraw a Consent.",
    );
  }
  if (authorization.kind === "provisioning") {
    if (state.userId !== authorization.subject.userId || state.accountId !== authorization.subject.accountId) {
      throw new ConsentRecordingAuthorizationError(
        "consent_provisioning_subject_mismatch",
        "Provisioned Consent withdrawal must name the provisioned User and Account.",
      );
    }
    return;
  }

  assertActorSubjectMatches(state.subjectType, state.userId, state.accountId, authorization.subject);
}

function issueAuthorization(
  kind: ConsentAuthorizationKind,
  userIdValue: unknown,
  accountIdValue: unknown,
): ConsentRecordingAuthorization {
  const userId = requireIdentifier(userIdValue, "usr", "authorization subject user");
  const accountId = requireIdentifier(accountIdValue, "acc", "authorization subject account");

  const authorization = Object.freeze({
    kind,
    subject: Object.freeze({ userId, accountId }),
  }) as ConsentRecordingAuthorization;
  issuedAuthorizations.add(authorization);
  return authorization;
}

function requireIssuedAuthorization(value: unknown): ConsentRecordingAuthorization {
  if (!isRecord(value)) {
    throw malformedAuthorization();
  }
  assertExactKeys(value, ["kind", "subject"]);
  if (typeof value.kind !== "string" || !authorizationKinds.has(value.kind as ConsentAuthorizationKind)) {
    throw malformedAuthorization();
  }
  if (!isRecord(value.subject)) {
    throw malformedAuthorization();
  }
  assertExactKeys(value.subject, ["accountId", "userId"]);

  const subject = value.subject;
  requireIdentifier(subject.userId, "usr", "authorization subject user");
  requireIdentifier(subject.accountId, "acc", "authorization subject account");
  assertSubjectIsNotShared(subject.userId as UserId, subject.accountId as AccountId);

  if (!issuedAuthorizations.has(value)) {
    throw new ConsentRecordingAuthorizationError(
      "consent_authorization_untrusted",
      "Consent authorization must be minted by a named trusted constructor.",
    );
  }

  return value as ConsentRecordingAuthorization;
}

function assertActorSubjectMatches(
  subjectType: ConsentState["subjectType"],
  userId: UserId | null,
  accountId: AccountId | null,
  authorized: ConsentAuthorizationSubject,
): void {
  if (subjectType === "account") {
    if (accountId !== authorized.accountId) {
      throw new ConsentRecordingAuthorizationError(
        "consent_account_not_authorized",
        "Account-scoped Consent must name the authoritative request Account.",
      );
    }
    if (userId !== authorized.userId) {
      throw new ConsentRecordingAuthorizationError(
        "consent_acting_user_not_authorized",
        "Account-scoped Consent must name the authoritative acting User.",
      );
    }
    return;
  }

  if (userId !== authorized.userId) {
    throw new ConsentRecordingAuthorizationError(
      "consent_user_not_authorized",
      "User-scoped Consent must name the authoritative request User.",
    );
  }
  if (accountId !== null && accountId !== authorized.accountId) {
    throw new ConsentRecordingAuthorizationError(
      "consent_account_not_authorized",
      "Consent Account context must match the authoritative request Account.",
    );
  }
}

function assertCommandSubjectIsValid(command: RecordConsentCommand): void {
  if (command.subjectType !== "user" && command.subjectType !== "account") {
    throw invalidSubject();
  }
  if (command.userId !== undefined) {
    requireSubjectIdentifier(command.userId, "usr");
  }
  if (command.accountId !== undefined) {
    requireSubjectIdentifier(command.accountId, "acc");
  }
  if (command.subjectType === "user" && command.userId === undefined) {
    throw invalidSubject();
  }
  if (command.subjectType === "account" && (command.userId === undefined || command.accountId === undefined)) {
    throw invalidSubject();
  }
}

function assertSubjectIsNotShared(userId: UserId | null, accountId: AccountId | null): void {
  if ((userId !== null && sharedUserIds.has(userId)) || (accountId !== null && sharedAccountIds.has(accountId))) {
    throw new ConsentRecordingAuthorizationError(
      "consent_shared_principal_forbidden",
      "Shared platform principals cannot be Consent subjects.",
    );
  }
}

function requireSubjectIdentifier<Prefix extends "acc" | "usr">(
  value: unknown,
  prefix: Prefix,
): Prefix extends "usr" ? UserId : AccountId {
  try {
    return requireIdentifier(value, prefix, "Consent subject");
  } catch (error) {
    if (error instanceof ConsentRecordingAuthorizationError && error.code === "consent_authorization_malformed") {
      throw invalidSubject();
    }
    throw error;
  }
}

function requireIdentifier<Prefix extends "acc" | "usr">(
  value: unknown,
  prefix: Prefix,
  fieldName: string,
): Prefix extends "usr" ? UserId : AccountId {
  const expectedPrefix = `${prefix}_`;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length <= expectedPrefix.length ||
    !value.startsWith(expectedPrefix) ||
    /\s/.test(value)
  ) {
    throw new ConsentRecordingAuthorizationError(
      "consent_authorization_malformed",
      `${fieldName} must be a non-blank '${expectedPrefix}' identifier.`,
    );
  }
  return value as Prefix extends "usr" ? UserId : AccountId;
}

function assertExactKeys(value: Record<PropertyKey, unknown>, expectedKeys: readonly string[]): void {
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    [...actualKeys].sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw malformedAuthorization();
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedAuthorization(): ConsentRecordingAuthorizationError {
  return new ConsentRecordingAuthorizationError(
    "consent_authorization_malformed",
    "Consent authorization must match the closed trusted authorization schema.",
  );
}

function invalidSubject(): ConsentRecordingAuthorizationError {
  return new ConsentRecordingAuthorizationError(
    "consent_subject_invalid",
    "Consent subject identifiers must be present, non-blank, and use their canonical prefixes.",
  );
}
