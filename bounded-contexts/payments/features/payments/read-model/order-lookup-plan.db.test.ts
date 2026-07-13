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
import { module as paymentsModule } from "../../../index";
import { getCapturedPaymentByOrderId } from "./queries";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type PaymentsTestPools = Readonly<Record<"payments", PgTransactionalPool>>;

describeDb("payment order lookup plan", () => {
  let pools: PaymentsTestPools;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["payments"], "payments_order_lookup");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(paymentsModule, pools.payments);
    await seedCapturedPayments(pools.payments);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("plans order-scoped captured payment lookup through payments_payment_orders_order_idx", async () => {
    const plans: unknown[] = [];
    const explainingDb = {
      query: async <TRow = unknown>(sql: string, params?: readonly unknown[]) => {
        const client = await pools.payments.connect();
        try {
          await client.query("SET enable_seqscan = off");
          const explain = await client.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (FORMAT JSON, COSTS FALSE) ${sql}`,
            params,
          );
          plans.push(explain.rows[0]?.["QUERY PLAN"]);
          return await client.query<TRow>(sql, params);
        } finally {
          await client.query("RESET enable_seqscan").catch(() => undefined);
          client.release();
        }
      },
    };

    const payment = await getCapturedPaymentByOrderId(explainingDb, "ord_4242");

    expect(payment?.payment_id).toBe("pay_4242");
    expect(JSON.stringify(plans)).toContain("payments_payment_orders_order_idx");
  });
});

async function seedCapturedPayments(pool: PgTransactionalPool): Promise<void> {
  await pool.query(`
    INSERT INTO payments_payment_pages (
      payment_id,
      buyer_account_id,
      order_ids,
      amount,
      balance_credit_amount,
      processor_amount,
      marketplace_sales_fee_amount,
      marketplace_checkout_fee_amount,
      seller_net_amount,
      currency_code,
      processor_name,
      processor_payment_kind,
      processor_payment_reference,
      processor_status,
      status,
      created_at,
      updated_at,
      captured_at,
      last_stream_version
    )
    SELECT
      'pay_' || series.payment_number,
      'acc_' || (series.payment_number % 10),
      jsonb_build_array('ord_' || series.payment_number),
      10.00,
      0.00,
      10.00,
      0.00,
      0.00,
      10.00,
      'USD',
      'fake',
      'payment-intent',
      'pi_' || series.payment_number,
      'succeeded',
      'captured',
      TIMESTAMPTZ '2026-07-03 12:00:00+00' + (series.payment_number || ' seconds')::interval,
      TIMESTAMPTZ '2026-07-03 12:00:00+00' + (series.payment_number || ' seconds')::interval,
      TIMESTAMPTZ '2026-07-03 12:00:00+00' + (series.payment_number || ' seconds')::interval,
      1
    FROM generate_series(1, 20000) AS series(payment_number);

    INSERT INTO payments_payment_orders (payment_id, order_id)
    SELECT payment_id, payment_order_ids.order_id
    FROM payments_payment_pages
    CROSS JOIN LATERAL jsonb_array_elements_text(order_ids) AS payment_order_ids(order_id)
    ON CONFLICT (payment_id, order_id) DO NOTHING;

    ANALYZE payments_payment_pages;
    ANALYZE payments_payment_orders;
  `);
}
