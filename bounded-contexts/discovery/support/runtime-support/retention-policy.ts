import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const discoveryRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "expired-anonymous-product-alert-intents",
    tableName: "discovery_anonymous_product_alert_intents",
    predicateSql: "candidate.status IN ('claimed', 'expired') AND candidate.expires_at < now() - interval '30 days'",
    orderBySql: "candidate.expires_at ASC",
    intervalMs: 24 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];
