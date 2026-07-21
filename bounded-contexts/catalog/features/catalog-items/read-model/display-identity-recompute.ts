import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogItemId } from "../../../ids";
import type { CatalogItemCommand, CatalogItemEvent, CatalogItemState } from "../domain/domain";
import {
  resolveAndPersistCatalogItemDisplayIdentity,
  type DisplayIdentityItem,
  type PersistedDisplayIdentityResult,
} from "./display-identity";

export type DisplayIdentityRecomputeReason =
  | "catalog-item-changed"
  | "display-template-changed"
  | "blueprint-changed"
  | "category-changed"
  | "field-changed"
  | "reference-record-changed"
  | "alias-resolved"
  | "seed-template-reconciled"
  | "manual-backfill"
  | "repair";

export type DisplayIdentityRecomputeSource = Readonly<{
  eventType?: string;
  streamId?: string;
  recordedAt?: string;
}>;

export type DisplayIdentityRecomputeBatchResult = Readonly<{
  selected: number;
  processed: number;
  changed: number;
  unchanged: number;
  missing: number;
  failed: number;
}>;

export type DisplayIdentityRecomputeHealth = Readonly<{
  pending: number;
  running: number;
  completed: number;
  pendingWithError: number;
  oldestPendingAt: string | null;
  latestFailureMessage: string | null;
}>;

export type DisplayIdentityRecomputeRetentionOptions = Readonly<{
  completedBefore?: string;
  retentionDays?: number;
}>;

type DisplayIdentityRecomputeWorkRow = Readonly<{
  catalog_item_id: string;
}>;

export async function enqueueCatalogItemDisplayIdentityRecomputeWork(
  db: PgQueryable,
  itemIds: readonly string[],
  reason: DisplayIdentityRecomputeReason,
  source: DisplayIdentityRecomputeSource = {},
): Promise<number> {
  const ids = [...new Set(itemIds.map((itemId) => itemId.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return 0;
  }

  await db.query(
    `INSERT INTO catalog_item_display_identity_recompute_work (
       catalog_item_id,
       reason,
       source_event_type,
       source_stream_id,
       source_recorded_at,
       status,
       attempts,
       last_error,
       available_at,
       updated_at,
       completed_at
     )
     SELECT item_id, $2, $3, $4, $5, 'pending', 0, NULL, now(), now(), NULL
     FROM unnest($1::text[]) AS item_id
     ON CONFLICT (catalog_item_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       source_event_type = EXCLUDED.source_event_type,
       source_stream_id = EXCLUDED.source_stream_id,
       source_recorded_at = EXCLUDED.source_recorded_at,
       status = 'pending',
       attempts = 0,
       last_error = NULL,
       available_at = now(),
       updated_at = now(),
       completed_at = NULL`,
    [ids, reason, source.eventType ?? null, source.streamId ?? null, source.recordedAt ?? null],
  );

  return ids.length;
}

export async function enqueueAllCatalogItemDisplayIdentityRecomputeWork(
  db: PgQueryable,
  reason: DisplayIdentityRecomputeReason,
  source: DisplayIdentityRecomputeSource = {},
): Promise<number> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id ASC`,
  );
  return enqueueCatalogItemDisplayIdentityRecomputeWork(
    db,
    result.rows.map((row) => row.catalog_item_id),
    reason,
    source,
  );
}

export async function processCatalogItemDisplayIdentityRecomputeBatch(
  db: PgQueryable,
  commandHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>,
  context: EventStoreContext,
  options: Readonly<{ limit?: number; afterPersist?: (catalogItemId: string) => Promise<void> }> = {},
): Promise<DisplayIdentityRecomputeBatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 250));
  const work = await db.query<DisplayIdentityRecomputeWorkRow>(
    `SELECT catalog_item_id
     FROM catalog_item_display_identity_recompute_work
     WHERE status = 'pending' AND available_at <= now()
     ORDER BY updated_at ASC, catalog_item_id ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  let processed = 0;
  let changed = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;

  for (const row of work.rows) {
    try {
      const claimed = await markDisplayIdentityWorkRunning(db, row.catalog_item_id);
      if (!claimed) {
        continue;
      }
      const item = await loadDisplayIdentityItem(db, row.catalog_item_id);

      if (!item) {
        missing += 1;
        await markDisplayIdentityWorkCompleted(db, row.catalog_item_id);
        continue;
      }

      const result = await resolveAndPersistCatalogItemDisplayIdentity(db, item, new Date().toISOString());
      const published = await publishDisplayIdentityIfNeeded(commandHandler, context, result);
      if (published) {
        await markDisplayIdentityPublished(db, result);
      }
      await options.afterPersist?.(row.catalog_item_id);
      await markDisplayIdentityWorkCompleted(db, row.catalog_item_id);

      processed += 1;
      if (published) {
        changed += 1;
      } else {
        unchanged += 1;
      }
    } catch (error) {
      failed += 1;
      await markDisplayIdentityWorkFailed(db, row.catalog_item_id, error);
    }
  }

  return {
    selected: work.rows.length,
    processed,
    changed,
    unchanged,
    missing,
    failed,
  };
}

export async function getCatalogItemDisplayIdentityRecomputeHealth(
  db: PgQueryable,
): Promise<DisplayIdentityRecomputeHealth> {
  const counts = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
     FROM catalog_item_display_identity_recompute_work
     GROUP BY status`,
  );
  const pending = await db.query<{
    pending_with_error: string;
    oldest_pending_at: string | null;
    latest_failure_message: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND last_error IS NOT NULL)::text AS pending_with_error,
       MIN(created_at) FILTER (WHERE status = 'pending')::text AS oldest_pending_at,
       (ARRAY_AGG(last_error ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS latest_failure_message
     FROM catalog_item_display_identity_recompute_work`,
  );
  const countByStatus = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
  const pendingRow = pending.rows[0];

  return {
    pending: countByStatus.get("pending") ?? 0,
    running: countByStatus.get("running") ?? 0,
    completed: countByStatus.get("completed") ?? 0,
    pendingWithError: Number(pendingRow?.pending_with_error ?? 0),
    oldestPendingAt: pendingRow?.oldest_pending_at ?? null,
    latestFailureMessage: pendingRow?.latest_failure_message ?? null,
  };
}

export async function purgeCompletedCatalogItemDisplayIdentityRecomputeWork(
  db: PgQueryable,
  options: DisplayIdentityRecomputeRetentionOptions = {},
): Promise<number> {
  const completedBefore = options.completedBefore ?? retentionCutoff(options.retentionDays ?? 30);
  const result = await db.query(
    `DELETE FROM catalog_item_display_identity_recompute_work
     WHERE status = 'completed'
       AND completed_at IS NOT NULL
       AND completed_at < $1`,
    [completedBefore],
  );

  return result.rowCount ?? 0;
}

function retentionCutoff(retentionDays: number): string {
  const boundedDays = Math.max(1, Math.floor(retentionDays));
  return new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000).toISOString();
}

async function loadDisplayIdentityItem(db: PgQueryable, itemId: string): Promise<DisplayIdentityItem | null> {
  const result = await db.query<DisplayIdentityItem>(`SELECT * FROM catalog_items WHERE catalog_item_id = $1`, [
    itemId,
  ]);
  return result.rows[0] ?? null;
}

async function publishDisplayIdentityIfNeeded(
  commandHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>,
  context: EventStoreContext,
  result: PersistedDisplayIdentityResult,
): Promise<boolean> {
  if (!result.publicationRequired) {
    return false;
  }

  const { identity } = result;
  await commandHandler({
    streamId: `catalog.item-${identity.catalogItemId}`,
    command: {
      type: "RecordCatalogItemDisplayIdentity",
      catalogItemId: identity.catalogItemId as CatalogItemId,
      languageCode: identity.languageCode,
      title: identity.title,
      subtitle: identity.subtitle,
      displayTemplateKey: identity.templateKey,
      displayTemplateTargetKind: identity.templateTargetKind,
      displayTemplateTargetId: identity.templateTargetId,
      displayIdentityHash: identity.hash,
      resolverVersion: identity.resolverVersion,
      resolvedAt: result.resolvedAt,
      resolutionStatus: identity.resolutionStatus,
      missingTokens: identity.missingTokens,
    },
    context,
  });

  return true;
}

async function markDisplayIdentityPublished(db: PgQueryable, result: PersistedDisplayIdentityResult): Promise<void> {
  await db.query(
    `UPDATE catalog_item_display_identities
     SET last_published_display_identity_hash = $3,
       last_published_at = $4,
       updated_at = now()
     WHERE catalog_item_id = $1
       AND language_code = $2
       AND display_identity_hash = $3`,
    [result.identity.catalogItemId, result.identity.languageCode, result.identity.hash, result.resolvedAt],
  );
}

async function markDisplayIdentityWorkRunning(db: PgQueryable, itemId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE catalog_item_display_identity_recompute_work
     SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE catalog_item_id = $1 AND status = 'pending'`,
    [itemId],
  );
  return (result.rowCount ?? 0) === 1;
}

async function markDisplayIdentityWorkCompleted(db: PgQueryable, itemId: string): Promise<void> {
  await db.query(
    `UPDATE catalog_item_display_identity_recompute_work
     SET status = 'completed', updated_at = now(), completed_at = now()
     WHERE catalog_item_id = $1 AND status = 'running'`,
    [itemId],
  );
}

async function markDisplayIdentityWorkFailed(db: PgQueryable, itemId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `UPDATE catalog_item_display_identity_recompute_work
     SET status = 'pending',
       last_error = $2,
       available_at = now() + interval '1 minute',
       updated_at = now()
     WHERE catalog_item_id = $1 AND status = 'running'`,
    [itemId, message],
  );
}
