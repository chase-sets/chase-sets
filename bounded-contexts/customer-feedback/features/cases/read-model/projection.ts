import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { feedbackCaseEventTypes, type FeedbackCaseEvent, type FeedbackCaseWorkItem } from "../domain/feedback-case";

type ProjectedEvent = Readonly<{
  type: FeedbackCaseEvent["type"];
  streamId: string;
  streamVersion: number;
  data: FeedbackCaseEvent["data"];
  timing: Readonly<{ recordedAt: string }>;
}>;

export function buildFeedbackCaseProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return Object.fromEntries(
    feedbackCaseEventTypes.map((eventType) => [
      eventType,
      async (event: ProjectedEvent) => {
        await applyCurrentState(db, event);
        await recordTimeline(db, event);
      },
    ]),
  ) as unknown as ProjectorHandlerMap;
}

async function applyCurrentState(db: PgQueryable, event: ProjectedEvent): Promise<void> {
  const data = event.data;
  switch (event.type) {
    case "customer-feedback.case.opened": {
      const opened = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      await db.query(
        `INSERT INTO customer_feedback_feedback_cases (
           case_id, stream_id, invitation_id, survey_kind, survey_version, question_version,
           rating, submission_idempotency_key, submitted_at, open_reason, status, priority,
           consent_status, consent_version, consent_granted_at, consent_withdrawn_at,
           follow_up_status, follow_up_delivery_status, opened_at, created_at, updated_at, last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11,
           $12, $13, $14, $15, 'not-requested', 'not-requested', $16, $17, $17, $18
         )
         ON CONFLICT (case_id) DO UPDATE
         SET updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE customer_feedback_feedback_cases.last_stream_version < EXCLUDED.last_stream_version`,
        [
          opened.caseId,
          event.streamId,
          opened.sourceResponse.invitationId,
          opened.sourceResponse.surveyVersion.surveyKind,
          opened.sourceResponse.surveyVersion.surveyVersion,
          opened.sourceResponse.surveyVersion.questionVersion,
          opened.sourceResponse.rating,
          opened.sourceResponse.submissionIdempotencyKey,
          opened.sourceResponse.submittedAt,
          opened.openReason,
          opened.priority,
          opened.consent.status,
          opened.consent.version,
          opened.consent.grantedAt,
          opened.consent.withdrawnAt,
          opened.actedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      return;
    }
    case "customer-feedback.case.triaged":
      return update(db, event, `status = 'triaged', triaged_at = $4`, [data.actedAt]);
    case "customer-feedback.case.assigned": {
      const assigned = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, "owner_id = $4", [assigned.ownerId]);
    }
    case "customer-feedback.case.unassigned":
      return update(db, event, "owner_id = NULL", []);
    case "customer-feedback.case.priority-set": {
      const priority = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, "priority = $4", [priority.priority]);
    }
    case "customer-feedback.case.due-date-set": {
      const due = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, "due_at = $4", [due.dueAt]);
    }
    case "customer-feedback.case.disposition-set": {
      const disposition = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(
        db,
        event,
        `status = 'actioned', disposition = $4, duplicate_of_case_id = $5, actioned_at = $6,
         follow_up_status = CASE
           WHEN $4 IN ('duplicate', 'spam', 'redacted') AND follow_up_status IN ('requested', 'sent')
             THEN 'cancelled'
           ELSE follow_up_status
         END`,
        [disposition.disposition, disposition.duplicateOfCaseId, disposition.actedAt],
      );
    }
    case "customer-feedback.case.work-item-linked": {
      const linked = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, "work_items = work_items || $4::jsonb", [JSON.stringify([linked.workItem])]);
    }
    case "customer-feedback.case.work-item-unlinked": {
      const unlinked = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(
        db,
        event,
        `work_items = COALESCE((
           SELECT jsonb_agg(item)
           FROM jsonb_array_elements(work_items) AS item
           WHERE NOT (item @> $4::jsonb)
         ), '[]'::jsonb)`,
        [JSON.stringify(workItemIdentity(unlinked.workItem))],
      );
    }
    case "customer-feedback.case.follow-up-requested": {
      const requested = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(
        db,
        event,
        `follow_up_status = 'requested', follow_up_delivery_status = $4,
         follow_up_channel = $5, follow_up_template_version = $6`,
        [
          requested.recipientAccountId ? "pending" : "no-recipient",
          requested.channel ?? "web",
          requested.templateVersion ?? 1,
        ],
      );
    }
    case "customer-feedback.case.follow-up-sent": {
      const sent = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(
        db,
        event,
        `follow_up_status = 'sent', follow_up_delivery_status = 'sent', follow_up_delivery_reference = $4,
         follow_up_channel = $5, follow_up_template_version = $6, follow_up_sent_at = $7`,
        [sent.deliveryReference, sent.channel ?? "web", sent.templateVersion ?? 1, sent.actedAt],
      );
    }
    case "customer-feedback.case.follow-up-delivery-outcome-recorded": {
      const outcome = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(
        db,
        event,
        `follow_up_delivery_status = $4, follow_up_delivery_reference = COALESCE($5, follow_up_delivery_reference),
         follow_up_channel = COALESCE($6, follow_up_channel), follow_up_template_version = COALESCE($7, follow_up_template_version),
         follow_up_sent_at = CASE WHEN $4 = 'sent' THEN $8 ELSE follow_up_sent_at END,
         follow_up_status = CASE
           WHEN $4 = 'sent' THEN 'sent'
           WHEN $4 IN ('suppressed', 'retry-exhausted', 'no-recipient') THEN 'cancelled'
           ELSE follow_up_status
         END`,
        [
          outcome.outcome,
          outcome.deliveryReference,
          outcome.channel ?? null,
          outcome.templateVersion ?? null,
          outcome.actedAt,
        ],
      );
    }
    case "customer-feedback.case.follow-up-outcome-recorded": {
      const outcome = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, `follow_up_status = 'completed', follow_up_outcome = $4`, [outcome.outcome]);
    }
    case "customer-feedback.case.attention-delivery-outcome-recorded": {
      const outcome = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, `attention_delivery_status = $4, attention_delivery_reference = $5`, [
        outcome.outcome,
        outcome.deliveryReference,
      ]);
    }
    case "customer-feedback.case.follow-up-consent-withdrawn":
      return update(
        db,
        event,
        `consent_status = 'withdrawn', consent_withdrawn_at = $4,
         follow_up_status = CASE
           WHEN follow_up_status IN ('requested', 'sent') THEN 'cancelled'
           ELSE follow_up_status
         END`,
        [data.actedAt],
      );
    case "customer-feedback.case.closed":
      return update(db, event, `status = 'closed', closed_at = $4`, [data.actedAt]);
    case "customer-feedback.case.reopened":
      return update(
        db,
        event,
        `status = 'triaged', disposition = NULL, duplicate_of_case_id = NULL,
         actioned_at = NULL, closed_at = NULL, reopened_at = $4,
         follow_up_status = CASE WHEN follow_up_status = 'cancelled' THEN 'not-requested' ELSE follow_up_status END`,
        [data.actedAt],
      );
    case "customer-feedback.case.attention-requested": {
      const attention = data as Extract<FeedbackCaseEvent, { type: typeof event.type }>["data"];
      return update(db, event, `attention_delivery_status = $4, attention_delivery_reference = NULL`, [
        attention.ownerId ? "pending" : "no-recipient",
      ]);
    }
    default:
      return assertNever(event.type);
  }
}

async function update(
  db: PgQueryable,
  event: ProjectedEvent,
  assignments: string,
  values: readonly unknown[],
): Promise<void> {
  await db.query(
    `UPDATE customer_feedback_feedback_cases
     SET ${assignments}, updated_at = $2, last_stream_version = $3
     WHERE case_id = $1
       AND last_stream_version < $3`,
    [event.data.caseId, event.timing.recordedAt, event.streamVersion, ...values],
  );
}

async function recordTimeline(db: PgQueryable, event: ProjectedEvent): Promise<void> {
  await db.query(
    `INSERT INTO customer_feedback_feedback_case_timeline (
       case_id, stream_version, event_type, actor_id, acted_at, event_data, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (case_id, stream_version) DO NOTHING`,
    [
      event.data.caseId,
      event.streamVersion,
      event.type,
      event.data.actorId,
      event.data.actedAt,
      JSON.stringify(event.data),
      event.timing.recordedAt,
    ],
  );
}

function workItemIdentity(workItem: FeedbackCaseWorkItem): FeedbackCaseWorkItem {
  return { kind: workItem.kind, reference: workItem.reference };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported feedback case event type: ${String(value)}`);
}
