import type { BcRetentionExemption, BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const marketplaceRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "expired-anonymous-listing-draft-intents",
    tableName: "marketplace_anonymous_listing_draft_intents",
    predicateSql: "candidate.status IN ('claimed', 'expired') AND candidate.expires_at < now() - interval '30 days'",
    orderBySql: "candidate.expires_at ASC",
    intervalMs: 24 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];

export const marketplaceRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "marketplace_supply_holds",
    owner: "marketplace",
    reason: "Supply-hold rows are mutable Inventory projections and must accept later lifecycle events.",
  },
];
