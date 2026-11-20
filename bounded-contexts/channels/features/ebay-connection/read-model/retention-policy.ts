import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const ebayConnectionRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "expired-ebay-oauth-attempts",
    tableName: "channels_ebay_oauth_attempts",
    predicateSql: "candidate.expires_at < CURRENT_TIMESTAMP",
    orderBySql: "candidate.expires_at ASC, candidate.state_hash ASC",
    intervalMs: 60 * 60 * 1000,
    batchLimit: 500,
  },
];
