import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CsatInvitationId, CsatSurveySubmittedEvent } from "../../../csat/domain/invitation";

type SubmittedResponseRow = Readonly<{
  invitation_id: string;
  survey_kind: string;
  survey_version: string;
  question_version: string;
  rating: number;
  comment: string | null;
  follow_up_consent: boolean;
  follow_up_consent_version: string;
  follow_up_consent_at: string | null;
  submission_idempotency_key: string;
  submitted_at: string;
}>;

export async function getSubmittedCsatResponseForCase(
  db: PgQueryable,
  invitationId: CsatInvitationId,
): Promise<CsatSurveySubmittedEvent["data"] | null> {
  const result = await db.query<SubmittedResponseRow>(
    `SELECT invitation_id, survey_kind, survey_version, question_version,
            rating, comment, follow_up_consent, follow_up_consent_version,
            follow_up_consent_at, submission_idempotency_key, submitted_at
     FROM customer_feedback_csat_invitations
     WHERE invitation_id = $1
       AND state = 'submitted'`,
    [invitationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!Number.isInteger(row.rating) || row.rating < 1 || row.rating > 5) {
    throw new Error("Submitted CSAT response projection contains an invalid rating.");
  }
  return {
    eventSchemaVersion: 1,
    invitationId: row.invitation_id as CsatInvitationId,
    surveyVersion: {
      surveyKind: row.survey_kind as CsatSurveySubmittedEvent["data"]["surveyVersion"]["surveyKind"],
      surveyVersion: row.survey_version,
      questionVersion: row.question_version,
    },
    rating: row.rating as CsatSurveySubmittedEvent["data"]["rating"],
    comment: row.comment,
    followUpConsent: row.follow_up_consent,
    followUpConsentVersion: row.follow_up_consent_version,
    followUpConsentAt: row.follow_up_consent_at,
    submissionIdempotencyKey: row.submission_idempotency_key,
    submittedAt: row.submitted_at,
  };
}
