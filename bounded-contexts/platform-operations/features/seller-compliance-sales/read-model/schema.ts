import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * Two replayable relations recording neutral, platform-processed seller sale facts.
 *
 * An Ordering event cannot key a sale because no payment identity exists yet, so
 * `platform_operations_seller_compliance_order_facts` (keyed by `order_id`) retains the
 * order-first facts until a Payments event supplies the payment identity, and
 * `platform_operations_seller_compliance_sales` (keyed by `(payment_id, order_id)`) holds
 * the sale itself. Every column is a recorded observation: nothing here evaluates a
 * threshold, classifies a seller, or asserts statutory applicability.
 *
 * Privacy: no buyer identity/contact, shipping or billing address, tax jurisdiction or
 * provider snapshot, processor reference, client secret, grading certification number,
 * email, or provider reference is stored. `sales_tax_*` is the buyer-charged sales tax
 * *money amount* the approved matrix needs kept distinct from item gross -- it is not tax
 * jurisdiction or provider data.
 */
const changeSequenceSql = `CREATE SEQUENCE IF NOT EXISTS platform_operations_seller_compliance_sales_change_seq AS bigint`;

const orderFactsTableSql = `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_order_facts (
  order_id text PRIMARY KEY,
  seller_account_id text NULL,
  item_subtotal_amount text NULL,
  shipping_charge_amount text NULL,
  shipping_allowance_amount text NULL,
  sales_tax_amount text NULL,
  authenticity_fee_amount text NULL,
  protection_amount text NULL,
  protection_allowance_amount text NULL,
  protection_overage_amount text NULL,
  order_total_amount text NULL,
  classification_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification_inputs_version integer NOT NULL DEFAULT 1,
  order_created_source_version bigint NULL,
  order_cancelled_source_version bigint NULL,
  cancelled_at timestamptz NULL,
  lifecycle_state text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  first_observed_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL
)`;

const salesTableSql = `CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_sales (
  payment_id text NOT NULL,
  order_id text NOT NULL,
  seller_account_id text NULL,
  sale_state text NOT NULL,
  occurred_at timestamptz NULL,
  currency_code text NULL,
  capture_payout_seller_account_id text NULL,
  capture_marketplace_sales_fee_amount text NULL,
  capture_seller_item_net_amount text NULL,
  capture_shipping_allowance_amount text NULL,
  capture_seller_shipping_payout_amount text NULL,
  capture_protection_amount text NULL,
  capture_protection_allowance_amount text NULL,
  capture_protection_overage_amount text NULL,
  capture_seller_payout_amount text NULL,
  item_gross_cents bigint NULL,
  shipping_charge_cents bigint NULL,
  sales_tax_cents bigint NULL,
  authenticity_fee_cents bigint NULL,
  protection_cents bigint NULL,
  protection_allowance_cents bigint NULL,
  protection_overage_cents bigint NULL,
  order_total_cents bigint NULL,
  marketplace_sales_fee_cents bigint NULL,
  seller_item_net_cents bigint NULL,
  shipping_allowance_cents bigint NULL,
  seller_shipping_payout_cents bigint NULL,
  seller_payout_cents bigint NULL,
  refunded_order_total_cents bigint NULL,
  order_refund_cap_cents bigint NULL,
  refund_observed_at timestamptz NULL,
  capture_atomic_anomalies jsonb NOT NULL DEFAULT '[]'::jsonb,
  capture_anomalies jsonb NOT NULL DEFAULT '[]'::jsonb,
  refund_anomalies jsonb NOT NULL DEFAULT '[]'::jsonb,
  reconciliation_mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification_inputs_version integer NOT NULL DEFAULT 1,
  cancelled_at timestamptz NULL,
  order_created_source_version bigint NULL,
  order_cancelled_source_version bigint NULL,
  payment_captured_source_version bigint NULL,
  payment_refunded_source_version bigint NULL,
  revision bigint NOT NULL DEFAULT 1,
  change_sequence bigint NOT NULL,
  recorded_at timestamptz NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (payment_id, order_id)
)`;

// Completed rows only: an order-only staging row has no sale occurrence and is never
// enumerated, so every sweep index is partial on `recorded_at IS NOT NULL`.
const salesSellerOccurrenceIndexSql = `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_sales_occurrence_idx
  ON platform_operations_seller_compliance_sales (seller_account_id, occurred_at, payment_id, order_id)
  WHERE recorded_at IS NOT NULL`;

const salesSellerChangeIndexSql = `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_sales_changed_at_idx
  ON platform_operations_seller_compliance_sales (seller_account_id, changed_at)
  WHERE recorded_at IS NOT NULL`;

const salesChangeSequenceIndexSql = `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_sales_change_seq_idx
  ON platform_operations_seller_compliance_sales (change_sequence)
  WHERE recorded_at IS NOT NULL`;

const salesOrderIndexSql = `CREATE INDEX IF NOT EXISTS platform_operations_seller_compliance_sales_order_idx
  ON platform_operations_seller_compliance_sales (order_id)`;

/**
 * The exact ordered object list. Boot schema and the ledgered migration are composed from
 * this one array, so they cannot drift: a boot-only or migration-only object is impossible
 * by construction rather than by review.
 */
export const sellerComplianceSalesSchemaStatements: readonly string[] = [
  changeSequenceSql,
  orderFactsTableSql,
  salesTableSql,
  salesSellerOccurrenceIndexSql,
  salesSellerChangeIndexSql,
  salesChangeSequenceIndexSql,
  salesOrderIndexSql,
];

export const sellerComplianceSalesSchemaSql = `${sellerComplianceSalesSchemaStatements.join(";\n\n")};\n`;

export const sellerComplianceSalesSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260905_platform_operations_seller_compliance_sale_facts",
    description:
      "Create the two seller-compliance sale-fact relations, their change sequence, and their bounded-sweep " +
      "indexes for databases booted before this slice. Every statement is composed from the same ordered array " +
      "as the boot schema, so an existing database and a freshly booted one converge on identical objects.",
    statements: sellerComplianceSalesSchemaStatements,
  },
];
