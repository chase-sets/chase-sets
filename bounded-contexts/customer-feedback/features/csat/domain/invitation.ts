/**
 * CSAT invitation identity, provenance, and versioned lifecycle event contracts.
 *
 * The invitation is the server-issued token that ties a presented survey back to
 * a real, sampled outcome fact. Its provenance is authoritative: it redeems a
 * source-context outcome fact rather than trusting client-supplied workflow or
 * entity references.
 *
 * This module defines the shape (`CsatInvitation`) and the VERSIONED lifecycle
 * event contracts. The aggregate that emits them is implemented downstream:
 *   - issues invitations (eligibility, sampling, expiry, provenance);
 *   - records presentation / dismissal / submission and projects CSAT.
 * They build their decider/evolver against these contracts so event shapes are
 * fixed at the gate and stay replay-stable.
 *
 * Versioning convention (this codebase has no event envelope version field): every
 * native `customer-feedback.*` event carries an explicit `eventSchemaVersion` in
 * its `data`, and all future fields are added as optional so stored events keep
 * decoding. See `../domain/replay-compat`.
 */
import type { DomainEvent } from "@chase-sets/event-core";
import type { TypedUlid } from "@chase-sets/primitives/typed-ids";
import type { CsatWorkflowOutcomeCode } from "./workflow-outcomes";
import type { SurveyVersionId } from "./survey";
import type { OutcomeSubjectKind, OutcomeSubjectRef } from "./outcome-fact";

export type CsatInvitationId = TypedUlid<"csatinv">;

/** Current native-event schema version for the customer-feedback stream. */
export const customerFeedbackEventSchemaVersion = 1 as const;
export type CustomerFeedbackEventSchemaVersion = typeof customerFeedbackEventSchemaVersion;

/**
 * Server-issued provenance. Every field is derived from the redeemed outcome fact,
 * never from the client. `outcomeIdempotencyKey` ties the invitation back to the
 * exact fact that authorized it (dedupe + audit).
 */
export type CsatInvitationProvenance = Readonly<{
  outcomeCode: CsatWorkflowOutcomeCode;
  sourceContext: string;
  subject: OutcomeSubjectRef;
  outcomeIdempotencyKey: string;
  samplingCohortKey: string;
}>;

export type CsatInvitationLifecycleState = "issued" | "presented" | "submitted" | "dismissed" | "expired";

/** The projected invitation read-model shape ( owns the projection). */
export type CsatInvitation = Readonly<{
  invitationId: CsatInvitationId;
  surveyVersion: SurveyVersionId;
  provenance: CsatInvitationProvenance;
  subjectAccountId: string;
  subjectKind: OutcomeSubjectKind;
  state: CsatInvitationLifecycleState;
  issuedAt: string;
  expiresAt: string;
  presentedAt: string | null;
  submittedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
}>;

type Versioned<TData> = TData & Readonly<{ eventSchemaVersion: CustomerFeedbackEventSchemaVersion }>;

// --- Versioned invitation lifecycle event contracts (emitted by /) ---

export type CsatInvitationIssuedEvent = DomainEvent<
  "customer-feedback.invitation.issued",
  Versioned<{
    invitationId: CsatInvitationId;
    surveyVersion: SurveyVersionId;
    provenance: CsatInvitationProvenance;
    subjectAccountId: string;
    subjectKind: OutcomeSubjectKind;
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
    surveyVersion: SurveyVersionId;
    rating: 1 | 2 | 3 | 4 | 5;
    comment: string | null;
    followUpConsent: boolean;
    followUpConsentVersion: string;
    followUpConsentAt: string | null;
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

/** The complete native invitation-lifecycle event union for the context. */
export type CustomerFeedbackInvitationEvent =
  | CsatInvitationIssuedEvent
  | CsatInvitationPresentedEvent
  | CsatSurveySubmittedEvent
  | CsatInvitationDismissedEvent
  | CsatInvitationExpiredEvent;

/** All native invitation-lifecycle event type strings (for subscription wiring). */
export const customerFeedbackInvitationEventTypes = [
  "customer-feedback.invitation.issued",
  "customer-feedback.invitation.presented",
  "customer-feedback.survey.submitted",
  "customer-feedback.invitation.dismissed",
  "customer-feedback.invitation.expired",
] as const;
export type CustomerFeedbackInvitationEventType = (typeof customerFeedbackInvitationEventTypes)[number];
