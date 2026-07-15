import type { DomainEvent } from "@chase-sets/event-core";
import type { InternalId, TypedUlid } from "@chase-sets/primitives/typed-ids";
import type { CsatSamplingDecision } from "./sampling";
import type { CsatWorkflowOutcomeCode } from "./workflow-outcomes";
import type { CsatRatingValue, SurveyVersionId } from "./survey";
import type { OutcomeSubjectKind, OutcomeSubjectRef } from "./outcome-fact";

export type CsatInvitationId = TypedUlid<"csatinv">;

/** Unguessable redemption authority exposed to browsers instead of the aggregate id. */
export type CsatInvitationPublicReference = InternalId<"csatref">;

/** Outcome-specific source entity allow-list for invitation provenance. */
export const csatInvitationSourceEntityTypes = {
  "checkout.completed": ["checkout-session"],
  "checkout.recovered": ["checkout-session"],
  "order.delivered": ["shipment"],
  "return.resolved": ["return"],
  "support.request-resolved": ["support-request"],
  "reputation.review-received": ["review"],
  "listing.published": ["listing"],
  "offer.accepted": ["offer"],
  "inventory.item-adjusted": ["inventory-item"],
  "payout.completed": ["payout"],
  "discovery.search-completed": ["search-session"],
  "registration.completed": ["account"],
  "authentication.completed": ["session"],
  "onboarding.completed": ["account"],
} as const satisfies Record<CsatWorkflowOutcomeCode, readonly string[]>;

export function isCsatInvitationSourceEntityType(code: CsatWorkflowOutcomeCode, entityType: string): boolean {
  return (csatInvitationSourceEntityTypes[code] as readonly string[]).includes(entityType);
}

export const customerFeedbackEventSchemaVersion = 1 as const;
export type CustomerFeedbackEventSchemaVersion = typeof customerFeedbackEventSchemaVersion;

/** Server-authoritative provenance copied only from a redeemed outcome fact. */
export type CsatInvitationProvenance = Readonly<{
  outcomeCode: CsatWorkflowOutcomeCode;
  sourceContext: string;
  subject: OutcomeSubjectRef;
  outcomeOccurredAt: string;
  outcomeIdempotencyKey: string;
  correlationId: string | null;
  samplingCohortKey: string;
}>;

export const csatInvitationLifecycleStates = [
  "eligible",
  "issued",
  "presented",
  "submitted",
  "dismissed",
  "expired",
  "suppressed",
  "revoked",
] as const;
export type CsatInvitationLifecycleState = (typeof csatInvitationLifecycleStates)[number];

export const csatSuppressionReasons = [
  "issuance-disabled",
  "sampled-out",
  "subject-cooldown",
  "subject-ineligible",
  "consent-revoked",
  "automated-or-test-traffic",
] as const;
export type CsatSuppressionReason = (typeof csatSuppressionReasons)[number];

/** Safe operational diagnostics. Never include comments, tokens, or source entity identifiers. */
export type CsatSuppressionDiagnostic = Readonly<{
  reason: CsatSuppressionReason;
  outcomeCode: CsatWorkflowOutcomeCode;
  policyId: string;
  policySchemaVersion: number;
  cohortKey: string;
  cooldownUntil: string | null;
}>;

export const csatRevocationReasons = ["policy-revoked", "consent-revoked", "account-ineligible"] as const;
export type CsatRevocationReason = (typeof csatRevocationReasons)[number];

/** Persisted aggregate shape; account-scoped public queries omit source entity identifiers. */
export type CsatInvitation = Readonly<{
  invitationId: CsatInvitationId;
  publicReference: CsatInvitationPublicReference | null;
  surveyVersion: SurveyVersionId;
  provenance: CsatInvitationProvenance;
  subjectAccountId: string;
  subjectKind: OutcomeSubjectKind;
  state: CsatInvitationLifecycleState;
  samplingDecision: CsatSamplingDecision | null;
  samplingPolicySchemaVersion: number | null;
  eligibleAt: string;
  issuedAt: string | null;
  expiresAt: string | null;
  presentedAt: string | null;
  submittedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  suppressedAt: string | null;
  revokedAt: string | null;
  revocationReason: CsatRevocationReason | null;
  suppressionDiagnostic: CsatSuppressionDiagnostic | null;
}>;

type Versioned<TData> = TData & Readonly<{ eventSchemaVersion: CustomerFeedbackEventSchemaVersion }>;

export type CsatInvitationEligibleEvent = DomainEvent<
  "customer-feedback.invitation.eligible",
  Versioned<{
    invitationId: CsatInvitationId;
    surveyVersion: SurveyVersionId;
    provenance: CsatInvitationProvenance;
    subjectAccountId: string;
    subjectKind: OutcomeSubjectKind;
    eligibleAt: string;
  }>
>;

export type CsatInvitationIssuedEvent = DomainEvent<
  "customer-feedback.invitation.issued",
  Versioned<{
    invitationId: CsatInvitationId;
    publicReference: CsatInvitationPublicReference;
    surveyVersion: SurveyVersionId;
    provenance: CsatInvitationProvenance;
    subjectAccountId: string;
    subjectKind: OutcomeSubjectKind;
    samplingDecision: CsatSamplingDecision;
    samplingPolicySchemaVersion: number;
    issuedAt: string;
    expiresAt: string;
  }>
>;

export type CsatInvitationPresentedEvent = DomainEvent<
  "customer-feedback.invitation.presented",
  Versioned<{ invitationId: CsatInvitationId; presentedAt: string }>
>;

export type CsatSurveySubmittedEvent = DomainEvent<
  "customer-feedback.survey.submitted",
  Versioned<{
    invitationId: CsatInvitationId;
    subjectAccountId?: string;
    surveyVersion: SurveyVersionId;
    rating: CsatRatingValue;
    comment: string | null;
    followUpConsent: boolean;
    followUpConsentVersion: string;
    followUpConsentAt: string | null;
    submissionIdempotencyKey: string;
    submittedAt: string;
  }>
>;

export type CsatInvitationDismissedEvent = DomainEvent<
  "customer-feedback.invitation.dismissed",
  Versioned<{ invitationId: CsatInvitationId; dismissedAt: string }>
>;

export type CsatInvitationExpiredEvent = DomainEvent<
  "customer-feedback.invitation.expired",
  Versioned<{ invitationId: CsatInvitationId; expiredAt: string }>
>;

export type CsatInvitationSuppressedEvent = DomainEvent<
  "customer-feedback.invitation.suppressed",
  Versioned<{
    invitationId: CsatInvitationId;
    samplingDecision: CsatSamplingDecision;
    diagnostic: CsatSuppressionDiagnostic;
    suppressedAt: string;
  }>
>;

export type CsatInvitationRevokedEvent = DomainEvent<
  "customer-feedback.invitation.revoked",
  Versioned<{ invitationId: CsatInvitationId; reason: CsatRevocationReason; revokedAt: string }>
>;

export type CustomerFeedbackInvitationEvent =
  | CsatInvitationEligibleEvent
  | CsatInvitationIssuedEvent
  | CsatInvitationPresentedEvent
  | CsatSurveySubmittedEvent
  | CsatInvitationDismissedEvent
  | CsatInvitationExpiredEvent
  | CsatInvitationSuppressedEvent
  | CsatInvitationRevokedEvent;

export const customerFeedbackInvitationEventTypes = [
  "customer-feedback.invitation.eligible",
  "customer-feedback.invitation.issued",
  "customer-feedback.invitation.presented",
  "customer-feedback.survey.submitted",
  "customer-feedback.invitation.dismissed",
  "customer-feedback.invitation.expired",
  "customer-feedback.invitation.suppressed",
  "customer-feedback.invitation.revoked",
] as const;
export type CustomerFeedbackInvitationEventType = (typeof customerFeedbackInvitationEventTypes)[number];
