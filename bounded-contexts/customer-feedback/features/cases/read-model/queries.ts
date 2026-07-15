import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { FeedbackCaseId } from "../domain";

export async function getFeedbackCaseStreamId(db: PgQueryable, caseId: FeedbackCaseId): Promise<string | null> {
  const result = await db.query<{ stream_id: string }>(
    `SELECT stream_id
     FROM customer_feedback_feedback_cases
     WHERE case_id = $1`,
    [caseId],
  );
  return result.rows[0]?.stream_id ?? null;
}

export async function getFeedbackCaseStreamIdByInvitationId(
  db: PgQueryable,
  invitationId: string,
): Promise<string | null> {
  const result = await db.query<{ stream_id: string }>(
    `SELECT stream_id FROM customer_feedback_feedback_cases WHERE invitation_id = $1`,
    [invitationId],
  );
  return result.rows[0]?.stream_id ?? null;
}
