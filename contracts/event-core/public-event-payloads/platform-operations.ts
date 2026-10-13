// Platform-Operations-owned public event payloads.
//
// Three surfaces land here: the two action-recorded facts cross-registered into
// `MarketplaceEventPayloads`, the `support.*` support-request coverage map (Platform
// Operations hosts that aggregate), and the `experience.platform-feedback.*` map.
import type { JsonValue } from "../../primitives/json";
import {
  parseStrictTypedUlid,
  type ListingId,
  type ReportedContentActionId,
  type UserId,
} from "../../primitives/typed-ids";
import type {
  SupportRequestPlatformCoverageRequestedV1Payload,
  SupportRequestRefundReleasedV1Payload,
  SupportRequestRemedyAuthorizedV1Payload,
  SupportRequestRemedyCompletedV1Payload,
} from "../platform-coverage-facts";

export type PlatformOperationsReportedContentActionRecordedPayload = Readonly<{
  actionId: string;
  targetType: "listing" | "review";
  targetId: string;
  action: "dismiss" | "contact-seller" | "unlist" | "escalate-account-suspension";
  note: string | null;
  operatorUserId: string | null;
  recordedAt: string;
}>;

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
  const time = input.directedAt;
  const parts =
    typeof time === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(time)
      : null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts ?? [];
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    !parts ||
    !Number.isFinite(Date.parse(time as string)) ||
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  ) {
    throw new Error("Listing Removal Directive time must be a calendar-valid timezone instant.");
  }
  return {
    actionId: parseStrictTypedUlid(input.actionId, "rca"),
    listingId: parseStrictTypedUlid(input.listingId, "lst"),
    operatorUserId: input.operatorUserId === null ? null : parseStrictTypedUlid(input.operatorUserId, "usr"),
    directedAt: time as string,
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
