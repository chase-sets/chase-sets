import {
  defineProjectorHandlers,
  resolveProjectionDb,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SavedListEventPayloads } from "../domain/domain";
import type { SavedListSharingEventPayloads } from "../domain/sharing-domain";

type SavedListSharedProjectionPayloads = SavedListEventPayloads & SavedListSharingEventPayloads;

export function buildSavedListSharedPageProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<SavedListSharedProjectionPayloads>({
    "collections.saved-list.created": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `INSERT INTO collections_saved_list_shared_pages (
           list_id, title, description, visibility, lifecycle, cover_line_id,
           ordered_line_ids, line_count, source_changed_at, source_version
         ) VALUES ($1, $2, $3, 'private', 'active', NULL, '[]'::jsonb, 0, $4, $5)
         ON CONFLICT (list_id) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           visibility = 'private',
           lifecycle = 'active',
           source_changed_at = EXCLUDED.source_changed_at,
           source_version = EXCLUDED.source_version`,
        [event.data.listId, event.data.title, event.data.description, event.data.createdAt, streamVersion(event)],
      );
      await target.query(
        `INSERT INTO collections_saved_list_access_policies (list_id, owner_account_id)
         VALUES ($1, $2)
         ON CONFLICT (list_id) DO UPDATE SET owner_account_id = EXCLUDED.owner_account_id`,
        [event.data.listId, event.data.ownerAccountId],
      );
    },
    "collections.saved-list.details-changed": async (event, context) => {
      await resolveProjectionDb(context, db).query(
        `UPDATE collections_saved_list_shared_pages
         SET title = $2, description = $3, source_changed_at = $4, source_version = $5
         WHERE list_id = $1`,
        [event.data.listId, event.data.title, event.data.description, event.data.changedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.archived": async (event, context) => {
      await resolveProjectionDb(context, db).query(
        `UPDATE collections_saved_list_shared_pages
         SET lifecycle = 'archived', source_changed_at = $2, source_version = $3
         WHERE list_id = $1`,
        [event.data.listId, event.data.archivedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.visibility-changed": async (event, context) => {
      await resolveProjectionDb(context, db).query(
        `UPDATE collections_saved_list_shared_pages
         SET visibility = $2, source_changed_at = $3, source_version = $4
         WHERE list_id = $1`,
        [event.data.listId, event.data.visibility, event.data.changedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.cover-changed": async (event, context) => {
      await resolveProjectionDb(context, db).query(
        `UPDATE collections_saved_list_shared_pages
         SET cover_line_id = $2, source_changed_at = $3, source_version = $4
         WHERE list_id = $1`,
        [event.data.listId, event.data.lineId, event.data.changedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.line-added": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `INSERT INTO collections_saved_list_shared_lines (list_id, line_id, product, tracked_quantity)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (list_id, line_id) DO UPDATE SET
           product = EXCLUDED.product,
           tracked_quantity = EXCLUDED.tracked_quantity`,
        [event.data.listId, event.data.lineId, JSON.stringify(event.data.product), event.data.trackedQuantity],
      );
      await target.query(
        `UPDATE collections_saved_list_shared_pages
         SET ordered_line_ids = CASE
               WHEN ordered_line_ids ? $2 THEN ordered_line_ids
               ELSE ordered_line_ids || to_jsonb($2::text)
             END,
             line_count = CASE WHEN ordered_line_ids ? $2 THEN line_count ELSE line_count + 1 END,
             source_changed_at = $3,
             source_version = $4
         WHERE list_id = $1`,
        [event.data.listId, event.data.lineId, event.data.addedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.line-changed": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `UPDATE collections_saved_list_shared_lines SET tracked_quantity = $3
         WHERE list_id = $1 AND line_id = $2`,
        [event.data.listId, event.data.lineId, event.data.trackedQuantity],
      );
      await target.query(
        `UPDATE collections_saved_list_shared_pages
         SET source_changed_at = $2, source_version = $3 WHERE list_id = $1`,
        [event.data.listId, event.data.changedAt, streamVersion(event)],
      );
    },
    "collections.saved-list.line-removed": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      const removed = await target.query<{ line_id: string }>(
        `DELETE FROM collections_saved_list_shared_lines
         WHERE list_id = $1 AND line_id = $2
         RETURNING line_id`,
        [event.data.listId, event.data.lineId],
      );
      const removedLine = removed.rows.length > 0;
      await target.query(
        `UPDATE collections_saved_list_shared_pages
         SET ordered_line_ids = CASE WHEN $5 THEN ordered_line_ids - $2 ELSE ordered_line_ids END,
             line_count = CASE WHEN $5 THEN GREATEST(line_count - 1, 0) ELSE line_count END,
             cover_line_id = CASE WHEN cover_line_id = $2 THEN NULL ELSE cover_line_id END,
             source_changed_at = $3,
             source_version = $4
         WHERE list_id = $1`,
        [event.data.listId, event.data.lineId, event.data.changedAt, streamVersion(event), removedLine],
      );
    },
    "collections.saved-list.line-reordered": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      const result = await target.query<{ ordered_line_ids: unknown }>(
        `SELECT ordered_line_ids FROM collections_saved_list_shared_pages WHERE list_id = $1`,
        [event.data.listId],
      );
      const current = stringArray(result.rows[0]?.ordered_line_ids);
      const reordered = reorderLine(current, event.data.lineId, event.data.afterLineId);
      await target.query(
        `UPDATE collections_saved_list_shared_pages
         SET ordered_line_ids = $2::jsonb, source_changed_at = $3, source_version = $4
         WHERE list_id = $1`,
        [event.data.listId, JSON.stringify(reordered), event.data.changedAt, streamVersion(event)],
      );
    },
    "collections.saved-list-sharing.configured": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `INSERT INTO collections_saved_list_access_policies (
           list_id, owner_account_id, policy_version, changed_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (list_id) DO UPDATE SET
           owner_account_id = EXCLUDED.owner_account_id,
           policy_version = EXCLUDED.policy_version,
           changed_at = EXCLUDED.changed_at`,
        [event.data.listId, event.data.ownerAccountId, streamVersion(event), event.data.configuredAt],
      );
      await updateDisclosure(
        target,
        event.data.listId,
        event.data.disclosure,
        streamVersion(event),
        event.data.configuredAt,
      );
    },
    "collections.saved-list-sharing.disclosure-changed": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await updateDisclosure(
        target,
        event.data.listId,
        event.data.disclosure,
        streamVersion(event),
        event.data.changedAt,
      );
      await updatePolicyVersion(target, event.data.listId, streamVersion(event), event.data.changedAt);
    },
    "collections.saved-list-sharing.unlisted-access-rotated": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `UPDATE collections_saved_list_access_policies
         SET unlisted_verifier = $2, unlisted_generation = $3, policy_version = $4, changed_at = $5
         WHERE list_id = $1`,
        [event.data.listId, event.data.verifier, event.data.generation, streamVersion(event), event.data.rotatedAt],
      );
      await updateSharedPagePolicyVersion(target, event.data.listId, streamVersion(event), event.data.rotatedAt);
    },
    "collections.saved-list-sharing.unlisted-access-revoked": async (event, context) => {
      const target = resolveProjectionDb(context, db);
      await target.query(
        `UPDATE collections_saved_list_access_policies
         SET unlisted_verifier = NULL, unlisted_generation = $2, policy_version = $3, changed_at = $4
         WHERE list_id = $1`,
        [event.data.listId, event.data.generation, streamVersion(event), event.data.revokedAt],
      );
      await updateSharedPagePolicyVersion(target, event.data.listId, streamVersion(event), event.data.revokedAt);
    },
  });
}

async function updateDisclosure(
  db: PgQueryable,
  listId: string,
  disclosure: Readonly<{ showTrackedQuantities: boolean; showCurrentEstimatedValue: boolean }>,
  policyVersion: number,
  changedAt: string,
) {
  await db.query(
    `UPDATE collections_saved_list_shared_pages
     SET show_tracked_quantities = $2,
         show_current_estimated_value = $3,
         policy_version = $4,
         policy_changed_at = $5
     WHERE list_id = $1`,
    [listId, disclosure.showTrackedQuantities, disclosure.showCurrentEstimatedValue, policyVersion, changedAt],
  );
}
async function updatePolicyVersion(db: PgQueryable, listId: string, version: number, changedAt: string) {
  await db.query(
    `UPDATE collections_saved_list_access_policies SET policy_version = $2, changed_at = $3 WHERE list_id = $1`,
    [listId, version, changedAt],
  );
}
async function updateSharedPagePolicyVersion(db: PgQueryable, listId: string, version: number, changedAt: string) {
  await db.query(
    `UPDATE collections_saved_list_shared_pages
     SET policy_version = $2, policy_changed_at = $3 WHERE list_id = $1`,
    [listId, version, changedAt],
  );
}
function streamVersion(event: Readonly<{ streamVersion?: unknown }>) {
  const version = Number(event.streamVersion ?? 0);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function reorderLine(current: readonly string[], lineId: string, afterLineId: string | null): string[] {
  if (!current.includes(lineId)) return [...current];
  const without = current.filter((candidate) => candidate !== lineId);
  if (afterLineId === null) return [lineId, ...without];
  const index = without.indexOf(afterLineId);
  if (index < 0) return [...current];
  return [...without.slice(0, index + 1), lineId, ...without.slice(index + 1)];
}
