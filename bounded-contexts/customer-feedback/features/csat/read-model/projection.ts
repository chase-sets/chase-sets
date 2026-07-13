import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CustomerFeedbackInvitationEvent } from "../domain/invitation";

export function buildCsatInvitationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "customer-feedback.invitation.eligible": async (event) => {
      const eligible = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.eligible" }
      >["data"];
      await db.query(
        `INSERT INTO customer_feedback_csat_invitations (
           invitation_id, stream_id, state, survey_kind, survey_version, question_version,
           outcome_code, source_context, source_entity_type, source_entity_id,
           outcome_occurred_at, outcome_idempotency_key, correlation_id,
           subject_account_id, subject_kind, eligible_at, created_at, updated_at, last_stream_version
         ) VALUES (
           $1, $2, 'eligible', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17
         )
         ON CONFLICT (invitation_id) DO UPDATE
         SET state = 'eligible',
             stream_id = $2,
             updated_at = $16,
             last_stream_version = $17
         WHERE customer_feedback_csat_invitations.last_stream_version < $17`,
        [
          eligible.invitationId,
          event.streamId,
          eligible.surveyVersion.surveyKind,
          eligible.surveyVersion.surveyVersion,
          eligible.surveyVersion.questionVersion,
          eligible.provenance.outcomeCode,
          eligible.provenance.sourceContext,
          eligible.provenance.subject.entityType,
          eligible.provenance.subject.entityId,
          eligible.provenance.outcomeOccurredAt,
          eligible.provenance.outcomeIdempotencyKey,
          eligible.provenance.correlationId,
          eligible.subjectAccountId,
          eligible.subjectKind,
          eligible.eligibleAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "customer-feedback.invitation.issued": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.issued" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'issued', public_reference = $4, sampling_decision = $5, sampling_policy_schema_version = $6,
         issued_at = $7, expires_at = $8`,
        [
          data.publicReference,
          JSON.stringify(data.samplingDecision),
          data.samplingPolicySchemaVersion,
          data.issuedAt,
          data.expiresAt,
        ],
      );
    },
    "customer-feedback.invitation.presented": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.presented" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'presented', presented_at = COALESCE(presented_at, $4)`,
        [data.presentedAt],
      );
    },
    "customer-feedback.invitation.dismissed": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.dismissed" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'dismissed', dismissed_at = COALESCE(dismissed_at, $4)`,
        [data.dismissedAt],
      );
    },
    "customer-feedback.survey.submitted": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.survey.submitted" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'submitted', rating = $4, comment = $5, follow_up_consent = $6,
         follow_up_consent_version = $7, follow_up_consent_at = $8,
         submission_idempotency_key = $9, submitted_at = $10`,
        [
          data.rating,
          data.comment,
          data.followUpConsent,
          data.followUpConsentVersion,
          data.followUpConsentAt,
          data.submissionIdempotencyKey,
          data.submittedAt,
        ],
      );
    },
    "customer-feedback.invitation.expired": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.expired" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'expired', expired_at = $4`,
        [data.expiredAt],
      );
    },
    "customer-feedback.invitation.suppressed": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.suppressed" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'suppressed', sampling_decision = $4, sampling_policy_schema_version = $5,
         suppression_diagnostic = $6, suppressed_at = $7`,
        [
          JSON.stringify(data.samplingDecision),
          data.samplingDecision.policySchemaVersion,
          JSON.stringify(data.diagnostic),
          data.suppressedAt,
        ],
      );
    },
    "customer-feedback.invitation.revoked": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.invitation.revoked" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `state = 'revoked', revoked_at = $4, revocation_reason = $5`,
        [data.revokedAt, data.reason],
      );
    },
  };
}

async function update(
  db: PgQueryable,
  streamVersion: number,
  recordedAt: string,
  invitationId: string,
  assignments: string,
  values: readonly unknown[],
): Promise<void> {
  await db.query(
    `UPDATE customer_feedback_csat_invitations
     SET ${assignments}, updated_at = $2, last_stream_version = $3
     WHERE invitation_id = $1
       AND last_stream_version < $3`,
    [invitationId, recordedAt, streamVersion, ...values],
  );
}
