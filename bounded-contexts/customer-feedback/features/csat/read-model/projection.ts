import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CustomerFeedbackInvitationEvent } from "../domain/invitation";
import {
  customerFeedbackRetentionPolicy,
  type CustomerFeedbackRetentionPolicyValue,
} from "../../privacy/domain/policy";

export function buildCsatInvitationProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    resolveRetentionPolicy?: () => Promise<CustomerFeedbackRetentionPolicyValue>;
  }> = {},
): ProjectorHandlerMap {
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
         follow_up_consent_version = $7, follow_up_consent_statement = $8, follow_up_consent_at = $9,
         follow_up_consent_subject_account_id = $10, follow_up_consent_purpose = $11,
         follow_up_consent_applicability = $12, submission_idempotency_key = $13, submitted_at = $14`,
        [
          data.rating,
          data.comment,
          data.followUpConsent,
          data.followUpConsentVersion,
          data.followUpConsentStatement,
          data.followUpConsentAt,
          data.followUpConsentSubjectAccountId,
          data.followUpConsentPurpose,
          data.followUpConsentApplicability,
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
    "customer-feedback.response.privacy-hold-placed": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.response.privacy-hold-placed" }
      >["data"];
      await update(db, event.streamVersion, event.timing.recordedAt, data.invitationId, "privacy_hold = $4::jsonb", [
        JSON.stringify({
          holdId: data.holdId,
          reason: data.reason,
          actorId: data.actorId,
          placedAt: data.placedAt,
          releasedAt: null,
        }),
      ]);
      await recordPrivacyAudit(
        db,
        data.invitationId,
        "hold-placed",
        data.actorId,
        "manage-feedback-holds",
        null,
        data.reason,
        data.placedAt,
        options.resolveRetentionPolicy,
      );
    },
    "customer-feedback.response.privacy-hold-released": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.response.privacy-hold-released" }
      >["data"];
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `privacy_hold = COALESCE(privacy_hold, '{}'::jsonb) || jsonb_build_object('releasedAt', $4::text)`,
        [data.releasedAt],
      );
      await recordPrivacyAudit(
        db,
        data.invitationId,
        "hold-released",
        data.actorId,
        "manage-feedback-holds",
        null,
        data.reason,
        data.releasedAt,
        options.resolveRetentionPolicy,
      );
    },
    "customer-feedback.response.redacted": async (event) => {
      const data = event.data as Extract<
        CustomerFeedbackInvitationEvent,
        { type: "customer-feedback.response.redacted" }
      >["data"];
      const redactContent = data.scope !== "direct-identifiers";
      const redactIdentifiers = data.scope !== "response-content";
      await update(
        db,
        event.streamVersion,
        event.timing.recordedAt,
        data.invitationId,
        `comment = CASE WHEN $4 THEN NULL ELSE comment END,
         response_content_redacted_at = CASE WHEN $4 THEN $5 ELSE response_content_redacted_at END,
         public_reference = CASE WHEN $6 THEN NULL ELSE public_reference END,
         source_entity_id = CASE WHEN $6 THEN '[redacted]' ELSE source_entity_id END,
         outcome_idempotency_key = CASE WHEN $6 THEN 'redacted:' || invitation_id ELSE outcome_idempotency_key END,
         correlation_id = CASE WHEN $6 THEN NULL ELSE correlation_id END,
         subject_account_id = CASE WHEN $6 THEN 'redacted:' || invitation_id ELSE subject_account_id END,
         follow_up_consent = CASE WHEN $6 THEN FALSE ELSE follow_up_consent END,
         follow_up_consent_at = CASE WHEN $6 THEN NULL ELSE follow_up_consent_at END,
         follow_up_consent_subject_account_id = CASE WHEN $6 THEN NULL ELSE follow_up_consent_subject_account_id END,
         submission_idempotency_key = CASE WHEN $6 THEN NULL ELSE submission_idempotency_key END,
         direct_identifiers_redacted_at = CASE WHEN $6 THEN $5 ELSE direct_identifiers_redacted_at END`,
        [redactContent, data.redactedAt, redactIdentifiers],
      );
      await recordPrivacyAudit(
        db,
        data.invitationId,
        "redacted",
        data.actorId,
        "redact-feedback",
        data.scope,
        data.reason,
        data.redactedAt,
        options.resolveRetentionPolicy,
      );
    },
  };
}

async function recordPrivacyAudit(
  db: PgQueryable,
  invitationId: string,
  action: string,
  actorId: string,
  capability: string,
  scope: string | null,
  reason: string,
  occurredAt: string,
  resolveRetentionPolicy: (() => Promise<CustomerFeedbackRetentionPolicyValue>) | undefined,
): Promise<void> {
  const policy = resolveRetentionPolicy ? await resolveRetentionPolicy() : customerFeedbackRetentionPolicy.defaultValue;
  await db.query(
    `INSERT INTO customer_feedback_response_privacy_audit
       (audit_id, invitation_id, action, actor_id, capability, scope, reason, outcome, occurred_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, 'succeeded', $8
     WHERE $8::timestamptz >= $9::timestamptz
     ON CONFLICT (audit_id) DO NOTHING`,
    [
      `${invitationId}:${action}:${occurredAt}`,
      invitationId,
      action,
      actorId,
      capability,
      scope,
      reason,
      occurredAt,
      new Date(Date.now() - policy.structuralAuditDays * 24 * 60 * 60 * 1_000).toISOString(),
    ],
  );
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
