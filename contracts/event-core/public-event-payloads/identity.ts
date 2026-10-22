// Identity-owned public event payloads.
import {
  parseStrictTypedUlid,
  type AccountId,
  type EnforcementActionId,
  type SupportRequestId,
  type TypedUlid,
} from "../../primitives/typed-ids";
import type { UserId } from "../../primitives/typed-ids";
import type { EmptyEventPayload } from "./event-core";

/** Closed provenance for suspension/closure; `operator-other` means a manual action with no more-specific cause. */
export const accountEnforcementReasonCodes = [
  "policy-violation",
  "fulfillment-failure",
  "payment-risk",
  "identity-verification",
  "seller-requested",
  "operator-other",
] as const;

export type AccountEnforcementReasonCode = (typeof accountEnforcementReasonCodes)[number];

/** Closed provenance for reactivation; no reason grants authority or changes lifecycle preconditions. */
export const accountEnforcementReversalReasonCodes = [
  "appeal-upheld",
  "issue-resolved",
  "operator-error",
  "operator-other",
] as const;

export type AccountEnforcementReversalReasonCode = (typeof accountEnforcementReversalReasonCodes)[number];

export type AccountEnforcementReference = Readonly<{
  kind: "support-request";
  supportRequestId: SupportRequestId;
}>;

export type AccountEnforcementData<Reason extends string> = Readonly<{
  version: 1;
  enforcementActionId: EnforcementActionId;
  reason: Reason;
  reference: AccountEnforcementReference | null;
}>;

export type AccountEnforcementEventPayload<Reason extends string> =
  | EmptyEventPayload
  | Readonly<{ enforcement: AccountEnforcementData<Reason> }>;

export type IdentityAccountSuspendedPayload = AccountEnforcementEventPayload<AccountEnforcementReasonCode>;
export type IdentityAccountReactivatedPayload = AccountEnforcementEventPayload<AccountEnforcementReversalReasonCode>;
export type IdentityAccountClosedPayload = AccountEnforcementEventPayload<AccountEnforcementReasonCode>;

export type IdentityFoundersWindowOpenedPayload = Readonly<{
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
  /** Additive grant-time recipient for downstream access notifications. */
  recipientEmail?: string;
}>;

export type IdentityFounderNumberClaimedPayload = Readonly<{
  accountId: AccountId;
  founderNumber: number;
  qualifyingActType: "listing-created" | "offer-submitted";
  qualifyingActId: string;
  claimedAt: string;
}>;

export type IdentityRegistrationCompletedPayload = Readonly<{
  accountId: AccountId;
  userId: UserId;
}>;

export type IdentityOnboardingCompletedPayload =
  | Readonly<{
      accountId: AccountId;
      userId: UserId;
      onboardingPath: "guest-account";
      invitationId?: never;
    }>
  | Readonly<{
      accountId: AccountId;
      userId: UserId;
      onboardingPath: "invitation";
      invitationId: string;
    }>;

export type IdentityAccountBadgeAssignedPayload = Readonly<{
  badgeKey: string;
  founderNumber?: number;
}>;

/** Closed reasons a signed-in Account may give when reporting another Account's profile. */
export const identityAccountProfileReportReasons = [
  "impersonation-or-deception",
  "harassment-or-abuse",
  "hate-or-discrimination",
  "sexual-exploitation",
  "personal-information",
  "spam-or-manipulation",
  "other",
] as const;

export type IdentityAccountProfileReportReason = (typeof identityAccountProfileReportReasons)[number];

export const identityAccountProfileReportDetailsMaxLength = 1000;

/**
 * Account Profile Report v1: one Account reported another Account's profile. The reported
 * Account (`targetId`) is the target owner. User, route and attempt identity stay
 * Identity-private and never appear here.
 */
export type IdentityAccountProfileReportSubmittedPayload = Readonly<{
  version: 1;
  reportId: TypedUlid<"rpt">;
  targetType: "account-profile";
  targetId: AccountId;
  reporterAccountId: AccountId;
  reason: IdentityAccountProfileReportReason;
  /** Trimmed reporter text of at most 1000 characters; blank text is `null`. */
  details: string | null;
  submittedAt: string;
}>;

const accountProfileReportKeys = [
  "version",
  "reportId",
  "targetType",
  "targetId",
  "reporterAccountId",
  "reason",
  "details",
  "submittedAt",
] as const;

/**
 * Reads a stored or candidate Account Profile Report. The record is closed: every key is
 * required, unknown and prototype keys are rejected, and an Account never reports itself.
 * The producer parses before append and every consumer parses before use.
 */
export function parseIdentityAccountProfileReportSubmittedPayload(
  value: unknown,
): IdentityAccountProfileReportSubmittedPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Account Profile Report must be an object.");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== accountProfileReportKeys.length ||
    accountProfileReportKeys.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new Error(`Account Profile Report requires exactly: ${accountProfileReportKeys.join(", ")}.`);
  }
  if (input.version !== 1) {
    throw new Error("Account Profile Report version is not supported.");
  }
  if (input.targetType !== "account-profile") {
    throw new Error("Account Profile Report target type must be account-profile.");
  }
  const reportId = accountProfileReportTypedUlid(input.reportId, "rpt", "report id");
  const targetId = accountProfileReportTypedUlid(input.targetId, "acc", "target id");
  const reporterAccountId = accountProfileReportTypedUlid(input.reporterAccountId, "acc", "reporter account id");
  if (reporterAccountId === targetId) {
    throw new Error("Account Profile Report reporter cannot report their own Account.");
  }
  if (!(identityAccountProfileReportReasons as readonly unknown[]).includes(input.reason)) {
    throw new Error("Account Profile Report reason is not supported.");
  }
  const details = input.details;
  if (
    details !== null &&
    (typeof details !== "string" ||
      details.length === 0 ||
      details.trim() !== details ||
      details.length > identityAccountProfileReportDetailsMaxLength)
  ) {
    throw new Error("Account Profile Report details must be null or trimmed text of at most 1000 characters.");
  }
  if (!isAccountProfileReportInstant(input.submittedAt)) {
    throw new Error("Account Profile Report time must be a calendar-valid timezone instant.");
  }
  return {
    version: 1,
    reportId,
    targetType: "account-profile",
    targetId,
    reporterAccountId,
    reason: input.reason as IdentityAccountProfileReportReason,
    details,
    submittedAt: input.submittedAt,
  };
}

function accountProfileReportTypedUlid<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  label: string,
): TypedUlid<Prefix> {
  try {
    if (typeof value !== "string") throw new Error();
    return parseStrictTypedUlid(value, prefix);
  } catch {
    throw new Error(`Account Profile Report ${label} must be a canonical '${prefix}_' ULID.`);
  }
}

/** A calendar-valid ISO instant with an explicit `Z` or `±hh:mm` offset; date-only text is rejected. */
function isAccountProfileReportInstant(value: unknown): value is string {
  const parts =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
      : null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts ?? [];
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parts !== null &&
    Number.isFinite(Date.parse(value as string)) &&
    calendar.getUTCFullYear() === Number(year) &&
    calendar.getUTCMonth() === Number(month) - 1 &&
    calendar.getUTCDate() === Number(day) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offsetHour ?? 0) <= 23 &&
    Number(offsetMinute ?? 0) <= 59
  );
}

export type IdentityEventPayloads = Readonly<{
  "identity.registration.completed": IdentityRegistrationCompletedPayload;
  "identity.onboarding.completed": IdentityOnboardingCompletedPayload;
  "identity.account-profile.report-submitted": IdentityAccountProfileReportSubmittedPayload;
  "identity.account.suspended": IdentityAccountSuspendedPayload;
  "identity.account.reactivated": IdentityAccountReactivatedPayload;
  "identity.account.closed": IdentityAccountClosedPayload;
  "identity.account.founders-window-opened": IdentityFoundersWindowOpenedPayload;
  "identity.founders-cohort.founder-number-claimed": IdentityFounderNumberClaimedPayload;
  "identity.account.badge-assigned": IdentityAccountBadgeAssignedPayload;
}>;
