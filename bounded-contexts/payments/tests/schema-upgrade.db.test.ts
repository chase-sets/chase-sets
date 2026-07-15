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

    const columns = await pools.payments.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'payments_refund_pages'
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
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
