import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { feedbackCaseEventTypes, type FeedbackCaseEvent } from "../../cases/domain/feedback-case";
import { triageDueAt } from "../domain/attention";

type ProjectedEvent = Readonly<{
  type: FeedbackCaseEvent["type"];
  streamVersion: number;
  data: FeedbackCaseEvent["data"];
  timing: Readonly<{ recordedAt: string }>;
}>;

export function buildFeedbackAttentionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return Object.fromEntries(
    feedbackCaseEventTypes.map((eventType) => [
      eventType,
      async (event: ProjectedEvent) => applyFeedbackAttentionEvent(db, event),
    ]),
  ) as unknown as ProjectorHandlerMap;
}

async function applyFeedbackAttentionEvent(db: PgQueryable, event: ProjectedEvent): Promise<void> {
  switch (event.type) {
    case "customer-feedback.case.opened": {
      const data = event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.opened" }>["data"];
      const attention = data.openReason === "low-score" && data.sourceResponse.rating <= 2;
      if (!attention) return;
      await db.query(
        `INSERT INTO customer_feedback_case_attention (
           attention_id, case_id, state, reason, rule_version, rating, priority, owner_id,
           opened_at, triaged_at, due_at, triage_due_at, closed_at, created_at, updated_at, last_stream_version
         ) VALUES ($1, $2, 'active', 'low-score', 'low-score-v1', $3, $4, NULL, $5, NULL, NULL, $6, NULL, $7, $7, $8)
         ON CONFLICT (attention_id) DO UPDATE
         SET updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE customer_feedback_case_attention.last_stream_version < EXCLUDED.last_stream_version`,
        [
          `${data.caseId}:opened`,
          data.caseId,
          data.sourceResponse.rating,
          data.priority,
          data.actedAt,
          triageDueAt(data.actedAt, data.priority),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      return;
    }
    case "customer-feedback.case.attention-requested": {
      const data = event.data as Extract<
        FeedbackCaseEvent,
        { type: "customer-feedback.case.attention-requested" }
      >["data"];
      await db.query(
        `INSERT INTO customer_feedback_case_attention (
           attention_id, case_id, state, reason, rule_version, rating, priority, owner_id,
           opened_at, triaged_at, due_at, triage_due_at, closed_at, created_at, updated_at, last_stream_version
         ) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, NULL, $9, $10, NULL, $8, $11, $12)
         ON CONFLICT (attention_id) DO UPDATE
         SET state = 'active', reason = EXCLUDED.reason, rule_version = EXCLUDED.rule_version,
             rating = EXCLUDED.rating, priority = EXCLUDED.priority, owner_id = EXCLUDED.owner_id,
             due_at = EXCLUDED.due_at, closed_at = NULL, updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE customer_feedback_case_attention.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.attentionId,
          data.caseId,
          data.reason,
          data.ruleVersion,
          data.rating,
          data.priority,
          data.ownerId,
          data.actedAt,
          data.dueAt,
          triageDueAt(data.actedAt, data.priority),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      return;
    }
    case "customer-feedback.case.assigned":
      return update(db, event, "owner_id = $2", [
        (event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.assigned" }>["data"]).ownerId,
      ]);
    case "customer-feedback.case.unassigned":
      return update(db, event, "owner_id = NULL", []);
    case "customer-feedback.case.priority-set":
      return update(db, event, "priority = $2", [
        (event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.priority-set" }>["data"]).priority,
      ]);
    case "customer-feedback.case.due-date-set":
      return update(db, event, "due_at = $2", [
        (event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.due-date-set" }>["data"]).dueAt,
      ]);
    case "customer-feedback.case.triaged":
      return update(db, event, "triaged_at = $2", [event.data.actedAt]);
    case "customer-feedback.case.closed":
      return update(db, event, "state = 'resolved', closed_at = $2", [event.data.actedAt]);
    case "customer-feedback.case.reopened":
      return update(db, event, "closed_at = NULL", []);
    default:
      return;
  }
}

async function update(db: PgQueryable, event: ProjectedEvent, assignments: string, values: readonly unknown[]) {
  await db.query(
    `UPDATE customer_feedback_case_attention
     SET ${assignments}, updated_at = $${values.length + 2}, last_stream_version = $${values.length + 3}
     WHERE case_id = $1 AND last_stream_version < $${values.length + 3}`,
    [event.data.caseId, ...values, event.timing.recordedAt, event.streamVersion],
  );
}
