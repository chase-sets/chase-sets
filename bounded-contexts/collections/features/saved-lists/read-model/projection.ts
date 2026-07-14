import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SavedListEventPayloads } from "../domain/domain";

type SavedListEventType = keyof SavedListEventPayloads;

function eventData<Type extends SavedListEventType>(event: Readonly<{ data: unknown }>): SavedListEventPayloads[Type] {
  return event.data as SavedListEventPayloads[Type];
}

async function refreshMembership(
  db: PgQueryable,
  input: Readonly<{
    listId: string;
    changedAt: string;
    streamVersion: number;
    globalPosition: string;
    removedLineId?: string;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE collections_saved_list_summaries AS summary
     SET line_count = membership.line_count,
         tracked_unit_count = membership.tracked_unit_count,
         cover_line_id = CASE WHEN summary.cover_line_id = $2 THEN NULL ELSE summary.cover_line_id END,
         changed_at = $3,
         last_global_position = $4::bigint,
         last_stream_version = $5
     FROM (
       SELECT
         COUNT(*)::integer AS line_count,
         COALESCE(SUM(tracked_quantity), 0)::bigint AS tracked_unit_count
       FROM collections_saved_list_lines
       WHERE list_id = $1
     ) AS membership
     WHERE summary.list_id = $1
       AND summary.last_stream_version < $5`,
    [input.listId, input.removedLineId ?? null, input.changedAt, input.globalPosition, input.streamVersion],
  );
}

export function buildSavedListProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "collections.saved-list.created": async (event) => {
      const data = eventData<"collections.saved-list.created">(event);

      await db.query(
        `INSERT INTO collections_saved_list_summaries (
           list_id,
           owner_account_id,
           title,
           description,
           visibility,
           lifecycle,
           line_count,
           tracked_unit_count,
           created_at,
           changed_at,
           created_global_position,
           last_global_position,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, 'active', 0, 0, $6, $6, $7::bigint, $7::bigint, $8)
         ON CONFLICT (list_id) DO UPDATE SET
           owner_account_id = EXCLUDED.owner_account_id,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           visibility = EXCLUDED.visibility,
           lifecycle = EXCLUDED.lifecycle,
           line_count = EXCLUDED.line_count,
           tracked_unit_count = EXCLUDED.tracked_unit_count,
           created_at = EXCLUDED.created_at,
           changed_at = EXCLUDED.changed_at,
           created_global_position = EXCLUDED.created_global_position,
           last_global_position = EXCLUDED.last_global_position,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE collections_saved_list_summaries.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.listId,
          data.ownerAccountId,
          data.title,
          data.description,
          data.visibility,
          data.createdAt,
          event.globalPosition,
          event.streamVersion,
        ],
      );
    },
    "collections.saved-list.details-changed": async (event) => {
      const data = eventData<"collections.saved-list.details-changed">(event);
      await db.query(
        `UPDATE collections_saved_list_summaries
         SET title = $2,
             description = $3,
             changed_at = $4,
             last_global_position = $5::bigint,
             last_stream_version = $6
         WHERE list_id = $1
           AND last_stream_version < $6`,
        [data.listId, data.title, data.description, data.changedAt, event.globalPosition, event.streamVersion],
      );
    },
    "collections.saved-list.archived": async (event) => {
      const data = eventData<"collections.saved-list.archived">(event);
      await db.query(
        `UPDATE collections_saved_list_summaries
         SET lifecycle = 'archived',
             archived_at = $2,
             changed_at = $2,
             last_global_position = $3::bigint,
             last_stream_version = $4
         WHERE list_id = $1
           AND last_stream_version < $4`,
        [data.listId, data.archivedAt, event.globalPosition, event.streamVersion],
      );
    },
    "collections.saved-list.visibility-changed": async (event) => {
      const data = eventData<"collections.saved-list.visibility-changed">(event);
      await db.query(
        `UPDATE collections_saved_list_summaries
         SET visibility = $2,
             changed_at = $3,
             last_global_position = $4::bigint,
             last_stream_version = $5
         WHERE list_id = $1
           AND last_stream_version < $5`,
        [data.listId, data.visibility, data.changedAt, event.globalPosition, event.streamVersion],
      );
    },
    "collections.saved-list.cover-changed": async (event) => {
      const data = eventData<"collections.saved-list.cover-changed">(event);
      await db.query(
        `UPDATE collections_saved_list_summaries
         SET cover_line_id = $2,
             changed_at = $3,
             last_global_position = $4::bigint,
             last_stream_version = $5
         WHERE list_id = $1
           AND last_stream_version < $5`,
        [data.listId, data.lineId, data.changedAt, event.globalPosition, event.streamVersion],
      );
    },
    "collections.saved-list.line-added": async (event) => {
      const data = eventData<"collections.saved-list.line-added">(event);
      await db.query(
        `INSERT INTO collections_saved_list_lines (
           line_id,
           list_id,
           catalog_item_id,
           product_id,
           selected_options,
           tracked_quantity,
           private_notes,
           private_tags,
           position,
           added_at,
           changed_at,
           last_stream_version
         )
         SELECT
           $1,
           $2,
           $3,
           $4,
           $5::jsonb,
           $6,
           $7,
           $8::jsonb,
           COALESCE(MAX(position), -1) + 1,
           $9,
           $9,
           $10
         FROM collections_saved_list_lines
         WHERE list_id = $2
         ON CONFLICT (line_id) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           product_id = EXCLUDED.product_id,
           selected_options = EXCLUDED.selected_options,
           tracked_quantity = EXCLUDED.tracked_quantity,
           private_notes = EXCLUDED.private_notes,
           private_tags = EXCLUDED.private_tags,
           added_at = EXCLUDED.added_at,
           changed_at = EXCLUDED.changed_at,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE collections_saved_list_lines.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.lineId,
          data.listId,
          data.product.catalogItemId,
          data.product.productId,
          JSON.stringify(data.product.selectedOptions),
          data.trackedQuantity,
          data.privateNotes,
          JSON.stringify(data.privateTags),
          data.addedAt,
          event.streamVersion,
        ],
      );
      await refreshMembership(db, {
        listId: data.listId,
        changedAt: data.addedAt,
        streamVersion: event.streamVersion,
        globalPosition: event.globalPosition,
      });
    },
    "collections.saved-list.line-changed": async (event) => {
      const data = eventData<"collections.saved-list.line-changed">(event);
      await db.query(
        `UPDATE collections_saved_list_lines
         SET tracked_quantity = $3,
             private_notes = $4,
             private_tags = $5::jsonb,
             changed_at = $6,
             last_stream_version = $7
         WHERE list_id = $1
           AND line_id = $2
           AND last_stream_version < $7`,
        [
          data.listId,
          data.lineId,
          data.trackedQuantity,
          data.privateNotes,
          JSON.stringify(data.privateTags),
          data.changedAt,
          event.streamVersion,
        ],
      );
      await refreshMembership(db, {
        listId: data.listId,
        changedAt: data.changedAt,
        streamVersion: event.streamVersion,
        globalPosition: event.globalPosition,
      });
    },
    "collections.saved-list.line-removed": async (event) => {
      const data = eventData<"collections.saved-list.line-removed">(event);
      await db.query(
        `WITH removed AS (
           DELETE FROM collections_saved_list_lines
           WHERE list_id = $1
             AND line_id = $2
             AND last_stream_version < $3
           RETURNING position
         )
         UPDATE collections_saved_list_lines
         SET position = position - 1,
             last_stream_version = $3
         WHERE list_id = $1
           AND position > COALESCE((SELECT position FROM removed), 2147483647)`,
        [data.listId, data.lineId, event.streamVersion],
      );
      await refreshMembership(db, {
        listId: data.listId,
        changedAt: data.changedAt,
        streamVersion: event.streamVersion,
        globalPosition: event.globalPosition,
        removedLineId: data.lineId,
      });
    },
    "collections.saved-list.line-reordered": async (event) => {
      const data = eventData<"collections.saved-list.line-reordered">(event);
      await db.query(
        `WITH remaining AS (
           SELECT
             line_id,
             ROW_NUMBER() OVER (ORDER BY position, line_id)::integer - 1 AS base_position
           FROM collections_saved_list_lines
           WHERE list_id = $1
             AND line_id <> $2
         ),
         target AS (
           SELECT CASE
             WHEN $3::text IS NULL THEN 0
             ELSE COALESCE(
               (SELECT base_position + 1 FROM remaining WHERE line_id = $3),
               (SELECT COUNT(*)::integer FROM remaining)
             )
           END AS position
         ),
         new_positions AS (
           SELECT
             line_id,
             CASE WHEN base_position >= target.position THEN base_position + 1 ELSE base_position END AS position
           FROM remaining
           CROSS JOIN target
           UNION ALL
           SELECT $2, target.position
           FROM target
         )
         UPDATE collections_saved_list_lines AS line
         SET position = new_positions.position,
             last_stream_version = GREATEST(line.last_stream_version, $4)
         FROM new_positions
         WHERE line.list_id = $1
           AND line.line_id = new_positions.line_id`,
        [data.listId, data.lineId, data.afterLineId, event.streamVersion],
      );
      await refreshMembership(db, {
        listId: data.listId,
        changedAt: data.changedAt,
        streamVersion: event.streamVersion,
        globalPosition: event.globalPosition,
      });
    },
  };
}
