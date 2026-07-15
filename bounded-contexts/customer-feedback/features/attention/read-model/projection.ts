import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { feedbackCaseEventTypes, type FeedbackCaseEvent } from "../../cases/domain/feedback-case";
import { feedbackAttentionEventTypes, type FeedbackAttentionEvent } from "../domain/attention-events";
import { triageDueAt } from "../domain/attention";

type ProjectedEvent = Readonly<{
  type: FeedbackCaseEvent["type"] | FeedbackAttentionEvent["type"];
  streamVersion: number;
  data: FeedbackCaseEvent["data"] | FeedbackAttentionEvent["data"];
  timing: Readonly<{ recordedAt: string }>;
}>;

export function buildFeedbackAttentionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return Object.fromEntries(
    [...feedbackCaseEventTypes, ...feedbackAttentionEventTypes].map((eventType) => [
      eventType,
      async (event: ProjectedEvent) => applyFeedbackAttentionEvent(db, event),
    ]),
  ) as unknown as ProjectorHandlerMap;
}

async function applyFeedbackAttentionEvent(db: PgQueryable, event: ProjectedEvent): Promise<void> {
  switch (event.type) {
    case "customer-feedback.case.opened":
      return;
    case "customer-feedback.case.attention-requested": {
      const data = event.data as Extract<
        FeedbackCaseEvent,
        { type: "customer-feedback.case.attention-requested" }
      >["data"];
      await db.query(
        `INSERT INTO customer_feedback_case_attention (
           attention_id, case_id, state, reason, rule_version, rating, priority, owner_id,
           opened_at, triaged_at, due_at, triage_due_at, closed_at, delivery_status,
           created_at, updated_at, last_stream_version
         ) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, NULL, $9, $10, NULL, $11, $8, $12, $13)
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
          data.ownerId ? "pending" : "no-recipient",
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
      return update(db, event, "triaged_at = $2", [
        (event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.triaged" }>["data"]).actedAt,
      ]);
    case "customer-feedback.case.closed":
      return update(db, event, "state = 'resolved', closed_at = $2", [
        (event.data as Extract<FeedbackCaseEvent, { type: "customer-feedback.case.closed" }>["data"]).actedAt,
      ]);
    case "customer-feedback.case.reopened":
      return update(db, event, "closed_at = NULL", []);
    case "customer-feedback.case.attention-delivery-outcome-recorded": {
      const data = event.data as Extract<
        FeedbackCaseEvent,
        { type: "customer-feedback.case.attention-delivery-outcome-recorded" }
      >["data"];
      await db.query(
        `UPDATE customer_feedback_case_attention
         SET delivery_status = $2, delivery_reference = $3, delivery_reported_at = $4,
             updated_at = $4, last_stream_version = $5
         WHERE attention_id = $1 AND last_stream_version < $5`,
        [data.attentionId, data.outcome, data.deliveryReference, data.actedAt, event.streamVersion],
      );
      return;
    }
    case "customer-feedback.attention.digest-requested": {
      const data = event.data as Extract<
        FeedbackAttentionEvent,
        { type: "customer-feedback.attention.digest-requested" }
      >["data"];
      await db.query(
        `INSERT INTO customer_feedback_attention_digest_runs (
           digest_id, window_start, window_end, group_key, recipient_user_id, item_count,
           capped, status, delivery_reference, requested_at, reported_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NULL, $9)
         ON CONFLICT (digest_id) DO NOTHING`,
        [
          data.digestId,
          data.windowStart,
          data.windowEnd,
          data.groupKey,
          data.recipientUserId,
          data.items.length,
          data.capped,
          data.recipientUserId ? "pending" : "no-recipient",
          data.requestedAt,
        ],
      );
      return;
    }
    case "customer-feedback.attention.digest-delivery-outcome-recorded": {
      const data = event.data as Extract<
        FeedbackAttentionEvent,
        { type: "customer-feedback.attention.digest-delivery-outcome-recorded" }
      >["data"];
      await db.query(
        `UPDATE customer_feedback_attention_digest_runs
         SET status = $2, delivery_reference = $3, reported_at = $4, updated_at = $4
         WHERE digest_id = $1`,
        [data.digestId, data.outcome, data.deliveryReference, data.reportedAt],
      );
      return;
    }
    default:
      return;
  }
}

async function update(db: PgQueryable, event: ProjectedEvent, assignments: string, values: readonly unknown[]) {
  await db.query(
    `UPDATE customer_feedback_case_attention
     SET ${assignments}, updated_at = $${values.length + 2}, last_stream_version = $${values.length + 3}
     WHERE case_id = $1 AND last_stream_version < $${values.length + 3}`,
    [(event.data as FeedbackCaseEvent["data"]).caseId, ...values, event.timing.recordedAt, event.streamVersion],
  );
}
