import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogItemId, ReferenceRecordId } from "../../../ids";
import type { CatalogItemCommand, CatalogItemEvent, CatalogItemState } from "../../catalog-items/domain/domain";
import type {
  ReferenceRecordCommand,
  ReferenceRecordEvent,
  ReferenceRecordState,
} from "../../reference-data/domain/domain";
import {
  resolveAndPersistCatalogItemAliases,
  resolveAndPersistReferenceRecordAliases,
  type PersistedResolvedCatalogItemAliasesResult,
  type PersistedResolvedReferenceRecordAliasesResult,
} from "./resolved-aliases";

// ---------------------------------------------------------------------------
// Resolved Alias recompute work (#1910)
//
// Bounded, resumable recompute for the published alias fact, mirroring the
// Resolved Display Identity recompute queue. Accepted-alias changes (accept,
// reject, revoke — see the alias projection / promotion writer #1909) enqueue a
// pending row for the affected target. The worker resolves the publishable
// aliases through the canonical resolver, persists the resolved fact, and
// publishes the `aliases-resolved` event only when the resolved hash changes.
//
// Backfill enqueues every target that already carries published aliases so the
// resolved facts can be rebuilt for existing promoted TCGdex records without a
// new alias change.
// ---------------------------------------------------------------------------

export type AliasRecomputeReason =
  | "alias-accepted"
  | "alias-revoked"
  | "alias-rejected"
  | "alias-proposed"
  | "promotion-reapplied"
  | "manual-backfill"
  | "repair";

export type AliasRecomputeSource = Readonly<{
  eventType?: string;
  streamId?: string;
  recordedAt?: string;
}>;

export type AliasRecomputeBatchResult = Readonly<{
  selected: number;
  processed: number;
  changed: number;
  unchanged: number;
  missing: number;
  failed: number;
}>;

export type AliasRecomputeHealth = Readonly<{
  pending: number;
  running: number;
  completed: number;
  pendingWithError: number;
  oldestPendingAt: string | null;
  latestFailureMessage: string | null;
}>;

export type AliasRecomputeRetentionOptions = Readonly<{
  completedBefore?: string;
  retentionDays?: number;
}>;

const CATALOG_ITEM_WORK_TABLE = "catalog_item_alias_recompute_work";
const REFERENCE_RECORD_WORK_TABLE = "catalog_reference_record_alias_recompute_work";

// --- Enqueue ---------------------------------------------------------------

export async function enqueueCatalogItemAliasRecomputeWork(
  db: PgQueryable,
  catalogItemIds: readonly string[],
  reason: AliasRecomputeReason,
  source: AliasRecomputeSource = {},
): Promise<number> {
  return enqueueAliasRecomputeWork(db, CATALOG_ITEM_WORK_TABLE, "catalog_item_id", catalogItemIds, reason, source);
}

export async function enqueueReferenceRecordAliasRecomputeWork(
  db: PgQueryable,
  referenceRecordIds: readonly string[],
  reason: AliasRecomputeReason,
  source: AliasRecomputeSource = {},
): Promise<number> {
  return enqueueAliasRecomputeWork(
    db,
    REFERENCE_RECORD_WORK_TABLE,
    "reference_record_id",
    referenceRecordIds,
    reason,
    source,
  );
}

/** Backfill: enqueue every Catalog Item that already carries any published alias. */
export async function enqueueAllCatalogItemAliasRecomputeWork(
  db: PgQueryable,
  reason: AliasRecomputeReason,
  source: AliasRecomputeSource = {},
): Promise<number> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT catalog_item_id FROM catalog_item_aliases ORDER BY catalog_item_id ASC`,
  );
  return enqueueCatalogItemAliasRecomputeWork(
    db,
    result.rows.map((row) => row.catalog_item_id),
    reason,
    source,
  );
}

/** Backfill: enqueue every Reference Record that already carries any published alias. */
export async function enqueueAllReferenceRecordAliasRecomputeWork(
  db: PgQueryable,
  reason: AliasRecomputeReason,
  source: AliasRecomputeSource = {},
): Promise<number> {
  const result = await db.query<{ reference_record_id: string }>(
    `SELECT DISTINCT reference_record_id
     FROM catalog_reference_record_aliases
     WHERE reference_record_id IS NOT NULL
     ORDER BY reference_record_id ASC`,
  );
  return enqueueReferenceRecordAliasRecomputeWork(
    db,
    result.rows.map((row) => row.reference_record_id),
    reason,
    source,
  );
}

async function enqueueAliasRecomputeWork(
  db: PgQueryable,
  table: string,
  idColumn: string,
  targetIds: readonly string[],
  reason: AliasRecomputeReason,
  source: AliasRecomputeSource,
): Promise<number> {
  const ids = [...new Set(targetIds.map((targetId) => targetId.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return 0;
  }

  await db.query(
    `INSERT INTO ${table} (
       ${idColumn},
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
     SELECT target_id, $2, $3, $4, $5, 'pending', 0, NULL, now(), now(), NULL
     FROM unnest($1::text[]) AS target_id
     ON CONFLICT (${idColumn}) DO UPDATE SET
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

// --- Process ---------------------------------------------------------------

export async function processCatalogItemAliasRecomputeBatch(
  db: PgQueryable,
  commandHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>,
  context: EventStoreContext,
  options: Readonly<{ limit?: number }> = {},
): Promise<AliasRecomputeBatchResult> {
  return processAliasRecomputeBatch(db, CATALOG_ITEM_WORK_TABLE, "catalog_item_id", options, async (targetId) => {
    const item = await loadCatalogItemLanguage(db, targetId);
    if (!item) {
      return "missing";
    }

    const results = await resolveAndPersistCatalogItemAliases(db, targetId, item.language_code, nowIso());
    await publishCatalogItemAliasesIfChanged(commandHandler, context, results);
    return results.some((result) => result.changed) ? "changed" : "unchanged";
  });
}

export async function processReferenceRecordAliasRecomputeBatch(
  db: PgQueryable,
  commandHandler: CommandHandler<ReferenceRecordCommand, ReferenceRecordState, ReferenceRecordEvent>,
  context: EventStoreContext,
  options: Readonly<{ limit?: number }> = {},
): Promise<AliasRecomputeBatchResult> {
  return processAliasRecomputeBatch(
    db,
    REFERENCE_RECORD_WORK_TABLE,
    "reference_record_id",
    options,
    async (targetId) => {
      const record = await loadReferenceRecordExists(db, targetId);
      if (!record) {
        return "missing";
      }

      const results = await resolveAndPersistReferenceRecordAliases(db, targetId, "en", nowIso());
      await publishReferenceRecordAliasesIfChanged(commandHandler, context, results);
      return results.some((result) => result.changed) ? "changed" : "unchanged";
    },
  );
}

type RecomputeOutcome = "changed" | "unchanged" | "missing";

async function processAliasRecomputeBatch(
  db: PgQueryable,
  table: string,
  idColumn: string,
  options: Readonly<{ limit?: number }>,
  resolveOne: (targetId: string) => Promise<RecomputeOutcome>,
): Promise<AliasRecomputeBatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 250));
  const work = await db.query<Record<string, string>>(
    `SELECT ${idColumn}
     FROM ${table}
     WHERE status = 'pending' AND available_at <= now()
     ORDER BY updated_at ASC, ${idColumn} ASC
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
    const targetId = row[idColumn];
    if (!targetId) {
      continue;
    }

    try {
      await markAliasWorkRunning(db, table, idColumn, targetId);
      const outcome = await resolveOne(targetId);
      await markAliasWorkCompleted(db, table, idColumn, targetId);

      if (outcome === "missing") {
        missing += 1;
      } else {
        processed += 1;
        if (outcome === "changed") {
          changed += 1;
        } else {
          unchanged += 1;
        }
      }
    } catch (error) {
      failed += 1;
      await markAliasWorkFailed(db, table, idColumn, targetId, error);
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

async function publishCatalogItemAliasesIfChanged(
  commandHandler: CommandHandler<CatalogItemCommand, CatalogItemState, CatalogItemEvent>,
  context: EventStoreContext,
  results: readonly PersistedResolvedCatalogItemAliasesResult[],
): Promise<void> {
  for (const result of results) {
    if (!result.changed) {
      continue;
    }
    const { resolved } = result;
    await commandHandler({
      streamId: `catalog.item-${resolved.catalogItemId}`,
      command: {
        type: "RecordCatalogItemAliases",
        catalogItemId: resolved.catalogItemId as CatalogItemId,
        aliasLanguageCode: resolved.aliasLanguageCode,
        aliases: resolved.aliases,
        resolvedAliasHash: resolved.resolvedAliasHash,
        resolverVersion: resolved.resolverVersion,
        resolvedAt: result.resolvedAt,
      },
      context,
    });
  }
}

async function publishReferenceRecordAliasesIfChanged(
  commandHandler: CommandHandler<ReferenceRecordCommand, ReferenceRecordState, ReferenceRecordEvent>,
  context: EventStoreContext,
  results: readonly PersistedResolvedReferenceRecordAliasesResult[],
): Promise<void> {
  for (const result of results) {
    if (!result.changed) {
      continue;
    }
    const { resolved } = result;
    await commandHandler({
      streamId: `catalog.reference-record-${resolved.referenceRecordId}`,
      command: {
        type: "RecordReferenceRecordAliases",
        referenceRecordId: resolved.referenceRecordId as ReferenceRecordId,
        aliasLanguageCode: resolved.aliasLanguageCode,
        aliases: resolved.aliases,
        resolvedAliasHash: resolved.resolvedAliasHash,
        resolverVersion: resolved.resolverVersion,
        resolvedAt: result.resolvedAt,
      },
      context,
    });
  }
}

// --- Health / retention ----------------------------------------------------

export async function getCatalogItemAliasRecomputeHealth(db: PgQueryable): Promise<AliasRecomputeHealth> {
  return getAliasRecomputeHealth(db, CATALOG_ITEM_WORK_TABLE);
}

export async function getReferenceRecordAliasRecomputeHealth(db: PgQueryable): Promise<AliasRecomputeHealth> {
  return getAliasRecomputeHealth(db, REFERENCE_RECORD_WORK_TABLE);
}

async function getAliasRecomputeHealth(db: PgQueryable, table: string): Promise<AliasRecomputeHealth> {
  const counts = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM ${table} GROUP BY status`,
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
     FROM ${table}`,
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

export async function purgeCompletedCatalogItemAliasRecomputeWork(
  db: PgQueryable,
  options: AliasRecomputeRetentionOptions = {},
): Promise<number> {
  return purgeCompletedAliasRecomputeWork(db, CATALOG_ITEM_WORK_TABLE, options);
}

export async function purgeCompletedReferenceRecordAliasRecomputeWork(
  db: PgQueryable,
  options: AliasRecomputeRetentionOptions = {},
): Promise<number> {
  return purgeCompletedAliasRecomputeWork(db, REFERENCE_RECORD_WORK_TABLE, options);
}

async function purgeCompletedAliasRecomputeWork(
  db: PgQueryable,
  table: string,
  options: AliasRecomputeRetentionOptions,
): Promise<number> {
  const completedBefore = options.completedBefore ?? retentionCutoff(options.retentionDays ?? 30);
  const result = await db.query(
    `DELETE FROM ${table}
     WHERE status = 'completed'
       AND completed_at IS NOT NULL
       AND completed_at < $1`,
    [completedBefore],
  );

  return result.rowCount ?? 0;
}

// --- Internals -------------------------------------------------------------

async function loadCatalogItemLanguage(
  db: PgQueryable,
  catalogItemId: string,
): Promise<{ language_code: string } | null> {
  const result = await db.query<{ language_code: string }>(
    `SELECT language_code FROM catalog_items WHERE catalog_item_id = $1`,
    [catalogItemId],
  );
  return result.rows[0] ?? null;
}

async function loadReferenceRecordExists(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<{ reference_record_id: string } | null> {
  const result = await db.query<{ reference_record_id: string }>(
    `SELECT reference_record_id FROM catalog_reference_records WHERE reference_record_id = $1`,
    [referenceRecordId],
  );
  return result.rows[0] ?? null;
}

async function markAliasWorkRunning(db: PgQueryable, table: string, idColumn: string, targetId: string): Promise<void> {
  await db.query(
    `UPDATE ${table}
     SET status = 'running', attempts = attempts + 1, updated_at = now()
     WHERE ${idColumn} = $1`,
    [targetId],
  );
}

async function markAliasWorkCompleted(
  db: PgQueryable,
  table: string,
  idColumn: string,
  targetId: string,
): Promise<void> {
  await db.query(
    `UPDATE ${table}
     SET status = 'completed', updated_at = now(), completed_at = now()
     WHERE ${idColumn} = $1`,
    [targetId],
  );
}

async function markAliasWorkFailed(
  db: PgQueryable,
  table: string,
  idColumn: string,
  targetId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `UPDATE ${table}
     SET status = 'pending',
       last_error = $2,
       available_at = now() + interval '1 minute',
       updated_at = now()
     WHERE ${idColumn} = $1`,
    [targetId, message],
  );
}

function retentionCutoff(retentionDays: number): string {
  const boundedDays = Math.max(1, Math.floor(retentionDays));
  return new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}
