import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as paymentsModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type PaymentsTestPools = Readonly<Record<"payments", PgTransactionalPool>>;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return columns.rows.map((row) => row.column_name);
}

describeDb("payments schema upgrades", () => {
  let pools: PaymentsTestPools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["payments"], "payments_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("converges the deployed pre-authenticity order-input table to the complete fresh schema", async () => {
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    const freshColumns = await readColumnNames(pools.payments, "payments_order_inputs");

    await resetMultiContextTestSchemas(pools);
    await pools.payments.query(`CREATE TABLE payments_order_inputs (
  order_id text PRIMARY KEY,
  source_type text NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  buyer_email text NULL,
  seller_account_id text NOT NULL DEFAULT '',
  sales_tax_amount numeric(12, 2) NOT NULL DEFAULT 0,
  total_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_amount numeric(12, 2) NOT NULL,
  marketplace_checkout_fee_amount numeric(12, 2) NOT NULL,
  seller_net_amount numeric(12, 2) NOT NULL,
  seller_item_net_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_overage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_shipping_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  seller_payout_amount numeric(12, 2) NOT NULL DEFAULT 0,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  status text NOT NULL,
  pending_payment_at timestamptz NULL,
  payment_deadline_at timestamptz NULL,
  payment_deadline_policy text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    const upgradedColumns = await readColumnNames(pools.payments, "payments_order_inputs");
    expect(upgradedColumns).toEqual(freshColumns);
    expect(upgradedColumns).toContain("authenticity_fee_amount");

    const migration = await pools.payments.query<{ migration_id: string }>(
      `SELECT migration_id
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260718_payments_order_inputs_authenticity_fee_amount'`,
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_payments_order_inputs_authenticity_fee_amount" }]);
  });

  it("converges deployed support refund effects on return inputs", async () => {
    await pools.payments.query(`CREATE TABLE payments_support_refund_effects (
  support_request_id text PRIMARY KEY,
  refund_effect_id text NOT NULL,
  order_id text NOT NULL,
  payment_id text NULL,
  refund_id text NULL,
  resolution_type text NOT NULL,
  requested_amount numeric(12, 2) NULL,
  status text NOT NULL,
  failure_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    expect(await readColumnNames(pools.payments, "payments_support_refund_effects")).toEqual(
      expect.arrayContaining([
        "attempts",
        "return_delivered_at",
        "refund_release_due_at",
        "return_condition_disputed_at",
        "return_shipping_deduction_amount",
      ]),
    );
  });

  it("bootstraps over the deployed refund table before adding remedy causation", async () => {
    await pools.payments.query(`CREATE TABLE payments_refund_pages (
  refund_id text PRIMARY KEY,
  payment_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  reason text NOT NULL,
  processor_name text NOT NULL,
  processor_refund_reference text NULL,
  processor_status text NOT NULL,
  status text NOT NULL,
  failure_code text NULL,
  failure_message text NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  issued_at timestamptz NULL,
  failed_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);`);

    await bootstrapContextDatabase(paymentsModule, pools.payments);

    expect(await readColumnNames(pools.payments, "payments_refund_pages")).toEqual(
      expect.arrayContaining([
        "remedy_id",
        "coverage_id",
        "liability_funding_kind",
        "seller_funded_amount",
        "platform_funded_amount",
        "refund_trigger",
        "reason_code",
      ]),
    );

    const indexes = await pools.payments.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'payments_refund_pages'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain("payments_refund_pages_remedy_idx");
  });
});
