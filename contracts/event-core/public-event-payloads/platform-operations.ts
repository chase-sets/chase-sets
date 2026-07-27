// Platform-Operations-owned public event payloads.
//
// Three surfaces land here: the two action-recorded facts cross-registered into
// `MarketplaceEventPayloads`, the `support.*` support-request coverage map (Platform
// Operations hosts that aggregate), and the `experience.platform-feedback.*` map.
import type { JsonValue } from "../../primitives/json";
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
  "experience.platform-feedback.submitted": PlatformFeedbackSubmittedPayload;
  "experience.platform-feedback.prompt-dismissed": PlatformFeedbackPromptDismissedPayload;
  "experience.platform-feedback.reviewed": PlatformFeedbackReviewedPayload;
  "experience.platform-feedback.archived": PlatformFeedbackArchivedPayload;
  "experience.platform-feedback.operator-note-recorded": PlatformFeedbackOperatorNoteRecordedPayload;
}>;
