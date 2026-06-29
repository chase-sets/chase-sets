import type { ChaseSetsEventPayloads } from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPlatformFeedbackProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<
      ChaseSetsEventPayloads,
      | "experience.platform-feedback.submitted"
      | "experience.platform-feedback.prompt-dismissed"
      | "experience.platform-feedback.reviewed"
      | "experience.platform-feedback.archived"
      | "experience.platform-feedback.operator-note-recorded"
    >
  >({
    "experience.platform-feedback.submitted": async (event) => {
      const data = event.data;

      await db.query(
        `INSERT INTO experience_platform_feedback_pages (
           feedback_id,
           user_id,
           account_id,
           rating,
           topic,
           comment,
           follow_up_consent,
           workflow,
           source_route_path,
           related_entities,
           related_entity_key,
           status,
           submitted_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'new', $12, $12
         )
         ON CONFLICT (feedback_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             topic = EXCLUDED.topic,
             comment = EXCLUDED.comment,
             follow_up_consent = EXCLUDED.follow_up_consent,
             workflow = EXCLUDED.workflow,
             source_route_path = EXCLUDED.source_route_path,
             related_entities = EXCLUDED.related_entities,
             related_entity_key = EXCLUDED.related_entity_key,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
        [
          data.feedbackId,
          data.userId,
          data.accountId,
          data.rating,
          data.topic,
          data.comment,
          data.followUpConsent,
          data.workflow,
          data.sourceRoutePath,
          JSON.stringify(data.relatedEntities),
          data.relatedEntityKey,
          data.submittedAt,
        ],
      );
    },
    "experience.platform-feedback.prompt-dismissed": async (event) => {
      const data = event.data;

      await db.query(
        `INSERT INTO experience_platform_feedback_prompt_pages (
           prompt_id,
           user_id,
           account_id,
           workflow,
           source_route_path,
           related_entities,
           related_entity_key,
           dismissed_at,
           snoozed_until,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $8
         )
         ON CONFLICT (prompt_id) DO UPDATE
         SET source_route_path = EXCLUDED.source_route_path,
             related_entities = EXCLUDED.related_entities,
             related_entity_key = EXCLUDED.related_entity_key,
             dismissed_at = EXCLUDED.dismissed_at,
             snoozed_until = EXCLUDED.snoozed_until,
             updated_at = EXCLUDED.updated_at`,
        [
          data.promptId,
          data.userId,
          data.accountId,
          data.workflow,
          data.sourceRoutePath,
          JSON.stringify(data.relatedEntities),
          data.relatedEntityKey,
          data.dismissedAt,
          data.snoozedUntil,
        ],
      );
    },
    "experience.platform-feedback.reviewed": async (event) => {
      const data = event.data as {
        feedbackId: string;
        reviewedByUserId: string;
        reviewedAt: string;
      };

      await db.query(
        `UPDATE experience_platform_feedback_pages
         SET status = 'reviewed',
             reviewed_by_user_id = $2,
             reviewed_at = $3,
             updated_at = $3
         WHERE feedback_id = $1`,
        [data.feedbackId, data.reviewedByUserId, data.reviewedAt],
      );
    },
    "experience.platform-feedback.archived": async (event) => {
      const data = event.data as {
        feedbackId: string;
        archivedByUserId: string;
        archivedAt: string;
      };

      await db.query(
        `UPDATE experience_platform_feedback_pages
         SET status = 'archived',
             archived_by_user_id = $2,
             archived_at = $3,
             updated_at = $3
         WHERE feedback_id = $1`,
        [data.feedbackId, data.archivedByUserId, data.archivedAt],
      );
    },
    "experience.platform-feedback.operator-note-recorded": async (event) => {
      const data = event.data as {
        feedbackId: string;
        noteId: string;
        body: string;
        recordedByUserId: string;
        recordedAt: string;
      };

      await db.query(
        `UPDATE experience_platform_feedback_pages
         SET operator_notes = operator_notes || $2::jsonb,
             updated_at = $3
         WHERE feedback_id = $1
           AND NOT operator_notes @> $4::jsonb`,
        [
          data.feedbackId,
          JSON.stringify([
            {
              noteId: data.noteId,
              body: data.body,
              recordedByUserId: data.recordedByUserId,
              recordedAt: data.recordedAt,
            },
          ]),
          data.recordedAt,
          JSON.stringify([{ noteId: data.noteId }]),
        ],
      );
    },
  });
}
