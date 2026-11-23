import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const collectionsRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "terminal-anonymous-saved-list-intents",
    tableName: "collections_anonymous_saved_list_intents",
    predicateSql:
      "candidate.status IN ('active', 'claimed', 'expired') AND candidate.expires_at < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM collections_saved_list_operations operation WHERE operation.intent_id = candidate.intent_id)",
    orderBySql: "candidate.expires_at ASC",
    intervalMs: 24 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
  {
    name: "terminal-saved-list-operations",
    tableName: "collections_saved_list_operations",
    predicateSql:
      "candidate.status IN ('applied', 'rejected', 'expired') AND candidate.terminal_at < now() - interval '30 days'",
    orderBySql: "candidate.terminal_at ASC",
    intervalMs: 24 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];
