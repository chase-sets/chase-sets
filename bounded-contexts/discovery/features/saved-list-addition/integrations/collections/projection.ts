import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const SAVED_LIST_STREAM_PREFIX = "collections.saved-list-";

function listIdFrom(event: Readonly<{ streamId: string }>) {
  return extractIdFromStreamId(event.streamId, SAVED_LIST_STREAM_PREFIX);
}

/** Mirrors Collections facts into Discovery's Add to List picker view. */
export function buildDiscoverySavedListPickerProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "collections.saved-list.created": async (event) => {
      const data = event.data as {
        ownerAccountId: string;
        title: string;
        createdAt: string;
      };
      await db.query(
        `INSERT INTO discovery_saved_list_picker (
           list_id,
           owner_account_id,
           title,
           lifecycle,
           line_count,
           tracked_unit_count,
           line_quantities,
           list_version,
           created_at,
           changed_at
         ) VALUES ($1, $2, $3, 'active', 0, 0, '{}'::jsonb, $4, $5, $5)
         ON CONFLICT (list_id) DO UPDATE SET
           owner_account_id = EXCLUDED.owner_account_id,
           title = EXCLUDED.title,
           lifecycle = EXCLUDED.lifecycle,
           line_count = EXCLUDED.line_count,
           tracked_unit_count = EXCLUDED.tracked_unit_count,
           line_quantities = EXCLUDED.line_quantities,
           list_version = EXCLUDED.list_version,
           created_at = EXCLUDED.created_at,
           changed_at = EXCLUDED.changed_at`,
        [listIdFrom(event), data.ownerAccountId, data.title, event.streamVersion, data.createdAt],
      );
    },
    "collections.saved-list.details-changed": async (event) => {
      const data = event.data as { title: string; changedAt: string };
      await db.query(
        `UPDATE discovery_saved_list_picker
         SET title = $2, list_version = $3, changed_at = $4
         WHERE list_id = $1`,
        [listIdFrom(event), data.title, event.streamVersion, data.changedAt],
      );
    },
    "collections.saved-list.archived": async (event) => {
      const data = event.data as { archivedAt: string };
      await db.query(
        `UPDATE discovery_saved_list_picker
         SET lifecycle = 'archived', list_version = $2, changed_at = $3
         WHERE list_id = $1`,
        [listIdFrom(event), event.streamVersion, data.archivedAt],
      );
    },
    "collections.saved-list.visibility-changed": updateVersionAndChangedAt(db),
    "collections.saved-list.cover-changed": updateVersionAndChangedAt(db),
    "collections.saved-list.line-reordered": updateVersionAndChangedAt(db),
    "collections.saved-list.line-added": async (event) => {
      const data = event.data as { lineId: string; trackedQuantity: number; addedAt: string };
      await db.query(
        `UPDATE discovery_saved_list_picker
         SET line_count = line_count + 1,
             tracked_unit_count = tracked_unit_count + $2,
             line_quantities = line_quantities || jsonb_build_object($3::text, $2::integer),
             list_version = $4,
             changed_at = $5
         WHERE list_id = $1`,
        [listIdFrom(event), data.trackedQuantity, data.lineId, event.streamVersion, data.addedAt],
      );
    },
    "collections.saved-list.line-changed": async (event) => {
      const data = event.data as { lineId: string; trackedQuantity: number; changedAt: string };
      await db.query(
        `UPDATE discovery_saved_list_picker
         SET tracked_unit_count = GREATEST(
               0,
               tracked_unit_count - COALESCE((line_quantities ->> $2)::integer, 0) + $3
             ),
             line_quantities = jsonb_set(line_quantities, ARRAY[$2]::text[], to_jsonb($3::integer), true),
             list_version = $4,
             changed_at = $5
         WHERE list_id = $1`,
        [listIdFrom(event), data.lineId, data.trackedQuantity, event.streamVersion, data.changedAt],
      );
    },
    "collections.saved-list.line-removed": async (event) => {
      const data = event.data as { lineId: string; changedAt: string };
      await db.query(
        `UPDATE discovery_saved_list_picker
         SET line_count = GREATEST(0, line_count - 1),
             tracked_unit_count = GREATEST(
               0,
               tracked_unit_count - COALESCE((line_quantities ->> $2)::integer, 0)
             ),
             line_quantities = line_quantities - $2,
             list_version = $3,
             changed_at = $4
         WHERE list_id = $1`,
        [listIdFrom(event), data.lineId, event.streamVersion, data.changedAt],
      );
    },
  };
}

function updateVersionAndChangedAt(db: PgQueryable) {
  return async (event: { streamId: string; streamVersion: number; data: unknown; timing: { recordedAt: string } }) => {
    const data = event.data as { changedAt?: string };
    await db.query(
      `UPDATE discovery_saved_list_picker
       SET list_version = $2, changed_at = $3
       WHERE list_id = $1`,
      [listIdFrom(event), event.streamVersion, data.changedAt ?? event.timing.recordedAt],
    );
  };
}
