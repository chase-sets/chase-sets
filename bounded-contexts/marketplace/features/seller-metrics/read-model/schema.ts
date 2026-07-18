import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

// The `disputes_*` / `dispute_rate` columns carry the externally-established
// "dispute rate" product name but are defined as the seller-responsible issue
// rate: `disputes_against_seller_count` is the count of distinct seller orders
// with a resolved support outcome whose Support responsibility fact is
// `seller`, and `dispute_rate` divides that by orders created in the window. A
// refund, replacement, or no-remedy outcome counts the same; carrier,
// platform, buyer, shared, and undetermined causes never count. See the
// GLOSSARY "Seller-Responsible Issue Rate" entry.
//
// `missing_responsibility_count` is the operational signal: resolved support
// outcomes in the window whose responsibility fact was missing or unrecognized.
// It is excluded from the numerator (fail-safe) and non-zero values are the
// monitoring hook for a broken upstream contract.
export const marketplaceSellerMetricsSummarySchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_seller_metrics_summary_pages (
  seller_account_id text PRIMARY KEY,
  window_days integer NOT NULL,
  orders_created_count integer NOT NULL DEFAULT 0,
  seller_cancelled_count integer NOT NULL DEFAULT 0,
  cancellation_rate numeric(5, 4) NULL,
  shipments_dispatched_count integer NOT NULL DEFAULT 0,
  shipments_on_time_count integer NOT NULL DEFAULT 0,
  on_time_shipment_rate numeric(5, 4) NULL,
  disputes_resolved_count integer NOT NULL DEFAULT 0,
  disputes_against_seller_count integer NOT NULL DEFAULT 0,
  dispute_rate numeric(5, 4) NULL,
  missing_responsibility_count integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
`;

export const marketplaceSellerMetricsSummarySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260718_marketplace_seller_metrics_missing_responsibility_count",
    description: "Converge existing seller-metrics summaries on the missing-responsibility signal.",
    statements: [
      `ALTER TABLE marketplace_seller_metrics_summary_pages
  ADD COLUMN IF NOT EXISTS missing_responsibility_count integer NOT NULL DEFAULT 0`,
    ],
  },
];
