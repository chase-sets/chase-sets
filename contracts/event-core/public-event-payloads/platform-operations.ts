// Platform-Operations-owned public event payloads.
//
// Three surfaces land here: the two action-recorded facts cross-registered into
// `MarketplaceEventPayloads`, the `support.*` support-request coverage map (Platform
// Operations hosts that aggregate), and the `experience.platform-feedback.*` map.
import type { JsonValue } from "../../primitives/json";
import {
  parseStrictTypedUlid,
  type AccountId,
  type ListingId,
  type ReportedContentActionId,
  type TypedUlid,
  type UserId,
} from "../../primitives/typed-ids";
import type {
  SupportRequestPlatformCoverageRequestedV1Payload,
  SupportRequestRefundReleasedV1Payload,
  SupportRequestRemedyAuthorizedV1Payload,
  SupportRequestRemedyCompletedV1Payload,
} from "../platform-coverage-facts";

/** Closed Reported Content targets; each target accepts exactly its own moderation actions. */
export const platformOperationsReportedContentActionsByTargetType = {
  listing: ["dismiss", "contact-seller", "unlist", "escalate-account-suspension"],
  review: [
    "dismiss",
    "contact-seller",
    "withdraw-review",
    "redact-review-feedback",
    "withdraw-review-reply",
    "escalate-account-suspension",
  ],
  "account-profile": ["dismiss", "contact-account", "redact-profile-display-name", "escalate-account-suspension"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type PlatformOperationsReportedContentTargetType =
  keyof typeof platformOperationsReportedContentActionsByTargetType;

export type PlatformOperationsReportedContentModerationActionFor<
  TargetType extends PlatformOperationsReportedContentTargetType,
> = (typeof platformOperationsReportedContentActionsByTargetType)[TargetType][number];

export type PlatformOperationsReportedContentModerationAction =
  PlatformOperationsReportedContentModerationActionFor<PlatformOperationsReportedContentTargetType>;

/** Actions whose audit must state the operator's reason; the event is the moderation audit trail. */
export const platformOperationsReportedContentActionsRequiringNote = [
  "withdraw-review",
  "redact-review-feedback",
  "withdraw-review-reply",
  "redact-profile-display-name",
] as const satisfies readonly PlatformOperationsReportedContentModerationAction[];

type ReportedContentActionRecordedFor<TargetType extends PlatformOperationsReportedContentTargetType> = Readonly<{
  actionId: ReportedContentActionId;
  targetType: TargetType;
  /** An Account Profile target is its Account; Listing and Review targets keep their historical free-form ids. */
  targetId: TargetType extends "account-profile" ? AccountId : string;
  action: PlatformOperationsReportedContentModerationActionFor<TargetType>;
  note: string | null;
  operatorUserId: string | null;
  recordedAt: string;
}>;

export type PlatformOperationsReportedContentActionRecordedPayload = {
  [TargetType in PlatformOperationsReportedContentTargetType]: ReportedContentActionRecordedFor<TargetType>;
}[PlatformOperationsReportedContentTargetType];

const reportedContentActionRecordedKeys = [
  "actionId",
  "targetType",
  "targetId",
  "action",
  "note",
  "operatorUserId",
  "recordedAt",
] as const;

export function isPlatformOperationsReportedContentTargetType(
  value: unknown,
): value is PlatformOperationsReportedContentTargetType {
  return typeof value === "string" && Object.hasOwn(platformOperationsReportedContentActionsByTargetType, value);
}

export function isPlatformOperationsReportedContentActionFor<
  TargetType extends PlatformOperationsReportedContentTargetType,
>(targetType: TargetType, value: unknown): value is PlatformOperationsReportedContentModerationActionFor<TargetType> {
  return (platformOperationsReportedContentActionsByTargetType[targetType] as readonly unknown[]).includes(value);
}

export function platformOperationsReportedContentActionRequiresNote(
  action: PlatformOperationsReportedContentModerationAction,
): boolean {
  return (platformOperationsReportedContentActionsRequiringNote as readonly string[]).includes(action);
}

/**
 * Reads a stored or candidate Reported Content action audit. The record is closed: every
 * key is required, unknown and prototype keys are rejected, the action must belong to its
 * target, and note-requiring actions must carry a nonblank note. Every consumer parses here.
 */
export function parsePlatformOperationsReportedContentActionRecordedPayload(
  value: unknown,
): PlatformOperationsReportedContentActionRecordedPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reported Content action audit must be an object.");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== reportedContentActionRecordedKeys.length ||
    reportedContentActionRecordedKeys.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new Error(`Reported Content action audit requires exactly: ${reportedContentActionRecordedKeys.join(", ")}.`);
  }
  const actionId = reportedContentTypedUlid(input.actionId, "rca", "action id");
  const targetType = input.targetType;
  if (!isPlatformOperationsReportedContentTargetType(targetType)) {
    throw new Error("Reported Content action target type is not supported.");
  }
  if (!isNonblankTrimmedText(input.targetId)) {
    throw new Error("Reported Content action target id must be a nonempty, unpadded string.");
  }
  const targetId =
    targetType === "account-profile" ? reportedContentTypedUlid(input.targetId, "acc", "target id") : input.targetId;
  if (!isPlatformOperationsReportedContentActionFor(targetType, input.action)) {
    throw new Error("Reported Content action is not valid for its target type.");
  }
  const action = input.action;
  if (input.note !== null && typeof input.note !== "string") {
    throw new Error("Reported Content action note must be a string or null.");
  }
  if (platformOperationsReportedContentActionRequiresNote(action) && !input.note?.trim()) {
    throw new Error("Reported Content action requires a note.");
  }
  if (input.operatorUserId !== null && !isNonblankTrimmedText(input.operatorUserId)) {
    throw new Error("Reported Content action operator must be a nonempty, unpadded string or null.");
  }
  if (!isTimezoneInstant(input.recordedAt)) {
    throw new Error("Reported Content action time must be a calendar-valid timezone instant.");
  }
  return {
    actionId,
    targetType,
    targetId,
    action,
    note: input.note,
    operatorUserId: input.operatorUserId,
    recordedAt: input.recordedAt,
  } as PlatformOperationsReportedContentActionRecordedPayload;
}

function reportedContentTypedUlid<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  label: string,
): TypedUlid<Prefix> {
  try {
    if (typeof value !== "string") throw new Error();
    return parseStrictTypedUlid(value, prefix);
  } catch {
    throw new Error(`Reported Content action ${label} must be a canonical '${prefix}_' ULID.`);
  }
}

function isNonblankTrimmedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isTimezoneInstant(value: unknown): value is string {
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

export type PlatformOperationsListingRemovalDirectedPayload = Readonly<{
  actionId: ReportedContentActionId;
  listingId: ListingId;
  operatorUserId: UserId | null;
  directedAt: string;
}>;

export function parsePlatformOperationsListingRemovalDirectedPayload(
  value: unknown,
): PlatformOperationsListingRemovalDirectedPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Listing Removal Directive must be an object.");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const fields = ["actionId", "listingId", "operatorUserId", "directedAt"];
  if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    throw new Error("Listing Removal Directive requires exactly actionId, listingId, operatorUserId and directedAt.");
  }
  if (
    typeof input.actionId !== "string" ||
    typeof input.listingId !== "string" ||
    (input.operatorUserId !== null && typeof input.operatorUserId !== "string")
  ) {
    throw new Error("Listing Removal Directive identities must be typed IDs; the operator may be null.");
  }
  if (!isTimezoneInstant(input.directedAt)) {
    throw new Error("Listing Removal Directive time must be a calendar-valid timezone instant.");
  }
  return {
    actionId: parseStrictTypedUlid(input.actionId, "rca"),
    listingId: parseStrictTypedUlid(input.listingId, "lst"),
    operatorUserId: input.operatorUserId === null ? null : parseStrictTypedUlid(input.operatorUserId, "usr"),
    directedAt: input.directedAt,
  };
}

export type PlatformOperationsRiskAlertActionRecordedPayload = Readonly<{
  actionId: string;
  alertId: string;
  action: "request-manual-payout-review" | "acknowledge";
  note: string | null;
  operatorUserId: string | null;
  recordedAt: string;
}>;

/**
 * Support-owned platform-covered resolution facts (ADR 0022). The `support.*` stream
 * prefix is the ubiquitous name for the support-request aggregate that Platform
 * Operations hosts; payload types and runtime validators live in
 * `../platform-coverage-facts`.
 */
export type SupportRequestPlatformCoverageEventPayloads = Readonly<{
  "support.support-request.remedy-authorized.v1": SupportRequestRemedyAuthorizedV1Payload;
  "support.support-request.platform-coverage-requested.v1": SupportRequestPlatformCoverageRequestedV1Payload;
  "support.support-request.refund-released.v1": SupportRequestRefundReleasedV1Payload;
  "support.support-request.remedy-completed.v1": SupportRequestRemedyCompletedV1Payload;
}>;

export type PlatformFeedbackSubmittedPayload = Readonly<{
  feedbackId: string;
  userId: string;
  accountId: string;
  rating: number;
  topic: string;
  comment: string | null;
  followUpConsent: boolean;
  workflow: string;
  sourceRoutePath: string;
  relatedEntities: readonly JsonValue[];
  relatedEntityKey: string | null;
  submittedAt: string;
}>;

export type PlatformFeedbackPromptDismissedPayload = Readonly<{
  promptId: string;
  userId: string;
  accountId: string;
  workflow: string;
  sourceRoutePath: string;
  relatedEntities: readonly JsonValue[];
  relatedEntityKey: string | null;
  dismissedAt: string;
  snoozedUntil: string;
}>;

export type PlatformFeedbackReviewedPayload = Readonly<{
  feedbackId: string;
  reviewedByUserId: string;
  reviewedAt: string;
}>;

export type PlatformFeedbackArchivedPayload = Readonly<{
  feedbackId: string;
  archivedByUserId: string;
  archivedAt: string;
}>;

export type PlatformFeedbackOperatorNoteRecordedPayload = Readonly<{
  feedbackId: string;
  noteId: string;
  body: string;
  recordedByUserId: string;
  recordedAt: string;
}>;

export type PlatformOperationsEventPayloads = Readonly<{
  "platform-operations.reported-content.listing-removal-directed": PlatformOperationsListingRemovalDirectedPayload;
  "experience.platform-feedback.submitted": PlatformFeedbackSubmittedPayload;
  "experience.platform-feedback.prompt-dismissed": PlatformFeedbackPromptDismissedPayload;
  "experience.platform-feedback.reviewed": PlatformFeedbackReviewedPayload;
  "experience.platform-feedback.archived": PlatformFeedbackArchivedPayload;
  "experience.platform-feedback.operator-note-recorded": PlatformFeedbackOperatorNoteRecordedPayload;
}>;
