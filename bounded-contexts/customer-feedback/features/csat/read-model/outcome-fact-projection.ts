import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type OutcomeFact = Readonly<{
  idempotencyKey: string;
  outcomeCode: string;
  sourceContext: string;
  subjectAccountId: string;
  subjectKind: string;
  subjectEntityType: string;
  subjectEntityId: string;
  outcomeOccurredAt: string;
  sourceEventId: string;
  performedByUserId: string;
  authenticationMethod: string | null;
  reasonCode: string | null;
}>;

export async function upsertOutcomeFact(db: PgQueryable, fact: OutcomeFact): Promise<void> {
  await db.query(
    `INSERT INTO customer_feedback_csat_outcome_facts
      (idempotency_key, outcome_code, source_context, subject_account_id, subject_kind,
       subject_entity_type, subject_entity_id, outcome_occurred_at, source_event_id,
       performed_by_user_id, authentication_method, reason_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       outcome_code = EXCLUDED.outcome_code,
       source_context = EXCLUDED.source_context,
       subject_account_id = EXCLUDED.subject_account_id,
       subject_kind = EXCLUDED.subject_kind,
       subject_entity_type = EXCLUDED.subject_entity_type,
       subject_entity_id = EXCLUDED.subject_entity_id,
       outcome_occurred_at = EXCLUDED.outcome_occurred_at,
       source_event_id = EXCLUDED.source_event_id,
       performed_by_user_id = EXCLUDED.performed_by_user_id,
       authentication_method = EXCLUDED.authentication_method,
       reason_code = EXCLUDED.reason_code`,
    [
      fact.idempotencyKey,
      fact.outcomeCode,
      fact.sourceContext,
      fact.subjectAccountId,
      fact.subjectKind,
      fact.subjectEntityType,
      fact.subjectEntityId,
      fact.outcomeOccurredAt,
      fact.sourceEventId,
      fact.performedByUserId,
      fact.authenticationMethod,
      fact.reasonCode,
    ],
  );
}
