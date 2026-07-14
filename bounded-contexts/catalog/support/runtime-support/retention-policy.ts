import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";

const HOUR_MS = 60 * 60 * 1_000;

export const catalogRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "stale-provider-option-query-cache",
    tableName: "catalog_provider_option_query_cache",
    predicateSql: "candidate.stale_until <= now()",
    orderBySql: "candidate.stale_until ASC",
    intervalMs: HOUR_MS,
    batchLimit: 500,
  },
  terminalWork("item-alias-recompute-work", "catalog_item_alias_recompute_work"),
  terminalWork("reference-record-alias-recompute-work", "catalog_reference_record_alias_recompute_work"),
  {
    name: "terminal-scope-sync-batch-units",
    tableName: "catalog_scope_sync_batch_units",
    predicateSql:
      "candidate.state IN ('completed', 'failed', 'cancelled') AND candidate.updated_at < now() - interval '30 days'",
    orderBySql: "candidate.updated_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
  {
    name: "terminal-scope-sync-batches",
    tableName: "catalog_scope_sync_batches",
    predicateSql:
      "candidate.status IN ('completed', 'partial', 'failed', 'cancelled') AND candidate.updated_at < now() - interval '30 days'",
    orderBySql: "candidate.updated_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
];

function terminalWork(name: string, tableName: string): BcRetentionSweep {
  return {
    name: `terminal-${name}`,
    tableName,
    predicateSql: "candidate.status IN ('completed', 'failed') AND candidate.updated_at < now() - interval '30 days'",
    orderBySql: "candidate.updated_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  };
}
