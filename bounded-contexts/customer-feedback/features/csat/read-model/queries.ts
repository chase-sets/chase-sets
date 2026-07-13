import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CsatInvitationPublicReference } from "../domain/invitation";
import type { CsatWorkflowOutcomeCode } from "../domain/workflow-outcomes";

export type CsatInvitationPageRow = Readonly<{
  invitation_id: string;
  public_reference: string | null;
  state: string;
  survey_kind: string;
  survey_version: string;
  question_version: string;
  outcome_code: string;
  subject_account_id: string;
  subject_kind: string;
  sampling_decision: unknown;
  sampling_policy_schema_version: number | null;
  eligible_at: string;
  issued_at: string | null;
  expires_at: string | null;
  presented_at: string | null;
  submitted_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
  suppressed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}>;

const publicInvitationColumns = `
  invitation_id,
  public_reference,
  state,
  survey_kind,
  survey_version,
  question_version,
  outcome_code,
  subject_account_id,
  subject_kind,
  sampling_decision,
  sampling_policy_schema_version,
  eligible_at,
  issued_at,
  expires_at,
  presented_at,
  submitted_at,
  dismissed_at,
  expired_at,
  suppressed_at,
  revoked_at,
  revocation_reason
`;

/** Account-scoped lookup prevents a valid public reference from crossing account boundaries. */
export async function getCsatInvitationByPublicReference(
  db: PgQueryable,
  publicReference: CsatInvitationPublicReference,
  subjectAccountId: string,
): Promise<CsatInvitationPageRow | null> {
  const result = await db.query<CsatInvitationPageRow>(
    `SELECT ${publicInvitationColumns}
     FROM customer_feedback_csat_invitations
     WHERE public_reference = $1
       AND subject_account_id = $2`,
    [publicReference, subjectAccountId],
  );
  return result.rows[0] ?? null;
}

/** Internal command-routing lookup; the stream id never enters the public page shape. */
export async function getCsatInvitationStreamIdByPublicReference(
  db: PgQueryable,
  publicReference: CsatInvitationPublicReference,
  subjectAccountId: string,
): Promise<string | null> {
  const result = await db.query<{ stream_id: string }>(
    `SELECT stream_id
     FROM customer_feedback_csat_invitations
     WHERE public_reference = $1
       AND subject_account_id = $2`,
    [publicReference, subjectAccountId],
  );
  return result.rows[0]?.stream_id ?? null;
}

export async function getLatestCsatInvitationIssuedAt(
  db: PgQueryable,
  subjectAccountId: string,
  outcomeCode: CsatWorkflowOutcomeCode,
): Promise<string | null> {
  const result = await db.query<{ issued_at: string }>(
    `SELECT issued_at
     FROM customer_feedback_csat_invitations
     WHERE subject_account_id = $1
       AND outcome_code = $2
       AND issued_at IS NOT NULL
     ORDER BY issued_at DESC
     LIMIT 1`,
    [subjectAccountId, outcomeCode],
  );
  return result.rows[0]?.issued_at ?? null;
}
