import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { CustomerFeedbackInvitationEvent } from "../domain/invitation";
import type { OutcomeSubjectKind } from "../domain/outcome-fact";
import type { CsatRatingValue, SurveyVersionId } from "../domain/survey";
import type { CsatWorkflowOutcomeCode } from "../domain/workflow-outcomes";

export type CsatAnalyticsFact = Readonly<{
  invitationId: string;
  surveyVersion: SurveyVersionId | null;
  outcomeCode: CsatWorkflowOutcomeCode | null;
  customerRole: OutcomeSubjectKind | null;
  samplingCohort: string | null;
  eligibleAt: string | null;
  issuedAt: string | null;
  presentedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  submittedAt: string | null;
  rating: CsatRatingValue | null;
  lastGlobalPosition: string;
  lastEventRecordedAt: string;
}>;

export type CsatAnalyticsFactPatch = Omit<CsatAnalyticsFact, "lastGlobalPosition" | "lastEventRecordedAt">;

const columns = [
  "invitation_id",
  "survey_kind",
  "survey_version",
  "question_version",
  "outcome_code",
  "customer_role",
  "sampling_cohort",
  "eligible_at",
  "issued_at",
  "presented_at",
  "dismissed_at",
  "expired_at",
  "submitted_at",
  "rating",
  "last_global_position",
  "last_event_recorded_at",
] as const;

export function buildCsatAnalyticsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project = async (event: TransportEvent) => {
    const patch = csatAnalyticsFactPatch(event);
    const surveyVersion = patch.surveyVersion;
    await db.query(
      `INSERT INTO customer_feedback_csat_analytics_facts (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT (invitation_id) DO UPDATE
       SET survey_kind = COALESCE(customer_feedback_csat_analytics_facts.survey_kind, EXCLUDED.survey_kind),
           survey_version = COALESCE(customer_feedback_csat_analytics_facts.survey_version, EXCLUDED.survey_version),
           question_version = COALESCE(customer_feedback_csat_analytics_facts.question_version, EXCLUDED.question_version),
           outcome_code = COALESCE(customer_feedback_csat_analytics_facts.outcome_code, EXCLUDED.outcome_code),
           customer_role = COALESCE(customer_feedback_csat_analytics_facts.customer_role, EXCLUDED.customer_role),
           sampling_cohort = COALESCE(customer_feedback_csat_analytics_facts.sampling_cohort, EXCLUDED.sampling_cohort),
           eligible_at = COALESCE(customer_feedback_csat_analytics_facts.eligible_at, EXCLUDED.eligible_at),
           issued_at = COALESCE(customer_feedback_csat_analytics_facts.issued_at, EXCLUDED.issued_at),
           presented_at = COALESCE(customer_feedback_csat_analytics_facts.presented_at, EXCLUDED.presented_at),
           dismissed_at = COALESCE(customer_feedback_csat_analytics_facts.dismissed_at, EXCLUDED.dismissed_at),
           expired_at = COALESCE(customer_feedback_csat_analytics_facts.expired_at, EXCLUDED.expired_at),
           submitted_at = COALESCE(customer_feedback_csat_analytics_facts.submitted_at, EXCLUDED.submitted_at),
           rating = COALESCE(customer_feedback_csat_analytics_facts.rating, EXCLUDED.rating),
           last_global_position = GREATEST(customer_feedback_csat_analytics_facts.last_global_position, EXCLUDED.last_global_position),
           last_event_recorded_at = GREATEST(customer_feedback_csat_analytics_facts.last_event_recorded_at, EXCLUDED.last_event_recorded_at),
           updated_at = now()`,
      [
        patch.invitationId,
        surveyVersion?.surveyKind ?? null,
        surveyVersion?.surveyVersion ?? null,
        surveyVersion?.questionVersion ?? null,
        patch.outcomeCode,
        patch.customerRole,
        patch.samplingCohort,
        patch.eligibleAt,
        patch.issuedAt,
        patch.presentedAt,
        patch.dismissedAt,
        patch.expiredAt,
        patch.submittedAt,
        patch.rating,
        event.globalPosition,
        event.timing.recordedAt,
      ],
    );
  };

  return Object.fromEntries(
    [
      "customer-feedback.invitation.eligible",
      "customer-feedback.invitation.issued",
      "customer-feedback.invitation.presented",
      "customer-feedback.invitation.dismissed",
      "customer-feedback.invitation.expired",
      "customer-feedback.survey.submitted",
    ].map((eventType) => [eventType, project]),
  );
}

export function csatAnalyticsFactPatch(event: TransportEvent): CsatAnalyticsFactPatch {
  const empty = {
    surveyVersion: null,
    outcomeCode: null,
    customerRole: null,
    samplingCohort: null,
    eligibleAt: null,
    issuedAt: null,
    presentedAt: null,
    dismissedAt: null,
    expiredAt: null,
    submittedAt: null,
    rating: null,
  } as const;

  switch (event.type) {
    case "customer-feedback.invitation.eligible": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.eligible" }
      >["data"];
      return {
        ...empty,
        invitationId: data.invitationId,
        surveyVersion: data.surveyVersion,
        outcomeCode: data.provenance.outcomeCode,
        customerRole: data.subjectKind,
        samplingCohort: data.provenance.samplingCohortKey,
        eligibleAt: data.eligibleAt,
      };
    }
    case "customer-feedback.invitation.issued": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.issued" }
      >["data"];
      return {
        ...empty,
        invitationId: data.invitationId,
        surveyVersion: data.surveyVersion,
        outcomeCode: data.provenance.outcomeCode,
        customerRole: data.subjectKind,
        samplingCohort: data.samplingDecision.cohortKey,
        issuedAt: data.issuedAt,
      };
    }
    case "customer-feedback.invitation.presented": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.presented" }
      >["data"];
      return { ...empty, invitationId: data.invitationId, presentedAt: data.presentedAt };
    }
    case "customer-feedback.invitation.dismissed": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.dismissed" }
      >["data"];
      return { ...empty, invitationId: data.invitationId, dismissedAt: data.dismissedAt };
    }
    case "customer-feedback.invitation.expired": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.expired" }
      >["data"];
      return { ...empty, invitationId: data.invitationId, expiredAt: data.expiredAt };
    }
    case "customer-feedback.survey.submitted": {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.survey.submitted" }
      >["data"];
      return {
        ...empty,
        invitationId: data.invitationId,
        surveyVersion: data.surveyVersion,
        submittedAt: data.submittedAt,
        rating: data.rating,
      };
    }
    default:
      throw new Error(`Unsupported CSAT analytics event '${event.type}'.`);
  }
}

/** Pure merge used to prove replay, duplicate, and out-of-order convergence. */
export function mergeCsatAnalyticsFact(
  current: CsatAnalyticsFact | null,
  patch: CsatAnalyticsFactPatch,
  event: Pick<TransportEvent, "globalPosition" | "timing">,
): CsatAnalyticsFact {
  const take = <T>(existing: T | null, incoming: T | null): T | null => existing ?? incoming;
  return {
    invitationId: patch.invitationId,
    surveyVersion: take(current?.surveyVersion ?? null, patch.surveyVersion),
    outcomeCode: take(current?.outcomeCode ?? null, patch.outcomeCode),
    customerRole: take(current?.customerRole ?? null, patch.customerRole),
    samplingCohort: take(current?.samplingCohort ?? null, patch.samplingCohort),
    eligibleAt: take(current?.eligibleAt ?? null, patch.eligibleAt),
    issuedAt: take(current?.issuedAt ?? null, patch.issuedAt),
    presentedAt: take(current?.presentedAt ?? null, patch.presentedAt),
    dismissedAt: take(current?.dismissedAt ?? null, patch.dismissedAt),
    expiredAt: take(current?.expiredAt ?? null, patch.expiredAt),
    submittedAt: take(current?.submittedAt ?? null, patch.submittedAt),
    rating: take(current?.rating ?? null, patch.rating),
    lastGlobalPosition:
      BigInt(current?.lastGlobalPosition ?? "0") > BigInt(event.globalPosition)
        ? (current?.lastGlobalPosition ?? "0")
        : String(event.globalPosition),
    lastEventRecordedAt:
      current && Date.parse(current.lastEventRecordedAt) > Date.parse(event.timing.recordedAt)
        ? current.lastEventRecordedAt
        : event.timing.recordedAt,
  };
}
