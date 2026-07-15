import type { BcRetentionExemption, BcRetentionSweep } from "@chase-sets/bounded-context-module";

export const fulfillmentRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "postage-provider-events",
    tableName: "fulfillment_postage_provider_events",
    predicateSql: "candidate.received_at < now() - interval '90 days'",
    orderBySql: "candidate.received_at ASC",
    intervalMs: 6 * 60 * 60 * 1_000,
    batchLimit: 500,
  },
];

export const fulfillmentRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "fulfillment_postage_label_operations",
    owner: "fulfillment",
    reason: "Postage purchase/void operation history is reconciliation evidence and requires an archive decision.",
  },
  {
    tableName: "fulfillment_return_shipment_label_operations",
    owner: "fulfillment",
    reason:
      "Return-label purchase/void operation history is reconciliation evidence for Settlement and requires an archive decision.",
  },
];
