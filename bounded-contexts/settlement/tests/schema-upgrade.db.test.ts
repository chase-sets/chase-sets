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
import { module as settlementModule } from "../index";
import { queryLiabilitySnapshot } from "../features/liability-reconciliation/read-model/liability-reconciliation";
import { getPayout, listPayouts } from "../features/payouts/read-model/queries";
import { lookupPayoutBySupportId, lookupPayoutBySupportReference } from "../features/payouts/read-model/support-lookup";
import {
  settlementFulfillmentSourceSchemaMigrations,
  settlementFulfillmentSourceSchemaSql,
} from "../features/wallets/integrations/fulfillment-source/fulfillment-source-schema";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("settlement schema upgrades", () => {
  let pools: Readonly<Record<"settlement", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["settlement"], "settlement_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("backfills stable hold identities outside boot-time schema SQL", async () => {
    const pool = pools.settlement;
    await bootstrapContextDatabase(settlementModule, pool);
    await pool.query("ALTER TABLE settlement_support_holds DROP COLUMN hold_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_settlement_support_holds_hold_id_convergence'",
    );
    await pool.query(`INSERT INTO settlement_support_holds (
      support_request_id, order_id, buyer_account_id, seller_account_id, flow_type,
      status, resolution_type, active, opened_at, updated_at
    ) VALUES (
      'sup_123', 'ord_123', 'acc_buyer', 'acc_seller', 'product-not-received',
      'opened', NULL, true, now(), now()
    )`);

    await bootstrapContextDatabase(settlementModule, pool);

    const hold = await pool.query<{ hold_id: string }>(
      "SELECT hold_id FROM settlement_support_holds WHERE support_request_id = 'sup_123'",
    );
    expect(hold.rows).toEqual([{ hold_id: "hold_123" }]);

    const column = await pool.query<{ is_nullable: string }>(`SELECT is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'settlement_support_holds'
        AND column_name = 'hold_id'`);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);

    const indexes = await pool.query<{ indexname: string }>(`SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'settlement_support_holds'`);
    expect(indexes.rows.map((row) => row.indexname)).toContain("settlement_support_holds_hold_id_idx");
  });

  it("backfills historical payout requested, fee, and net amounts", async () => {
    const pool = pools.settlement;
    await bootstrapContextDatabase(settlementModule, pool);
    await pool.query("DROP TRIGGER settlement_payout_pages_normalize_legacy_amounts ON settlement_payout_pages");
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id, account_id, amount, currency_code, display_reference, status, requested_at, updated_at
       ) VALUES ('pyo_legacy_fee_backfill', 'acc_legacy_fee_backfill', 42.00, 'usd', 'PYO-LEGACY', 'completed', now(), now())`,
    );
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260911_settlement_payout_fee_amounts'",
    );

    await bootstrapContextDatabase(settlementModule, pool);

    const result = await pool.query<{
      requested_amount: string;
      fee_amount: string;
      net_amount: string;
    }>(
      `SELECT requested_amount::text, fee_amount::text, net_amount::text
       FROM settlement_payout_pages
       WHERE payout_id = 'pyo_legacy_fee_backfill'`,
    );
    expect(result.rows).toEqual([{ requested_amount: "42.00", fee_amount: "0.00", net_amount: "42.00" }]);
  });

  it("normalizes an exact rolling old-projector insert after migration for every direct payout reader", async () => {
    const pool = pools.settlement;
    await bootstrapContextDatabase(settlementModule, pool);
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id,
         account_id,
         amount,
         currency_code,
         destination_reference,
         note,
         display_reference,
         status,
         provider_transfer_reference,
         provider_payout_reference,
         provider_status,
         provider_failure_code,
         provider_failure_message,
         requested_at,
         updated_at,
         sent_at,
         completed_at,
         failed_at,
         failure_reason,
         last_provider_event_at,
         last_reconciled_at,
         retry_count,
         next_retry_at,
         retry_reason,
         last_stream_version
       ) VALUES (
         'pyo_synthetic_old_projector',
         'acc_synthetic_old_projector',
         42.00,
         'usd',
         NULL,
         NULL,
         'PYO-SYNTHOLD',
         'requested',
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         '2026-09-11T00:00:00.000Z',
         '2026-09-11T00:00:00.000Z',
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         NULL,
         0,
         NULL,
         NULL,
         1
       )`,
    );
    await pool.query(
      `INSERT INTO settlement_payout_pages (
         payout_id, account_id, amount, requested_amount, fee_amount, net_amount,
         currency_code, display_reference, status, requested_at, updated_at, last_stream_version
       ) VALUES (
         'pyo_synthetic_current_fee', 'acc_synthetic_current_fee', 50.00, 50.00, 1.00, 49.00,
         'usd', 'PYO-SYNTHCURRENT', 'in-transit', now(), now(), 1
       )`,
    );

    const expectedLegacyAmounts = {
      amount: "42.00",
      requested_amount: "42.00",
      fee_amount: "0.00",
      net_amount: "42.00",
    };
    const rawLegacy = await pool.query<{
      amount: string;
      requested_amount: string;
      fee_amount: string;
      net_amount: string;
    }>(
      `SELECT amount::text, requested_amount::text, fee_amount::text, net_amount::text
       FROM settlement_payout_pages
       WHERE payout_id = 'pyo_synthetic_old_projector'`,
    );
    expect(rawLegacy.rows).toEqual([expectedLegacyAmounts]);
    await expect(listPayouts(pool, { accountId: "acc_synthetic_old_projector" })).resolves.toMatchObject({
      items: [expectedLegacyAmounts],
    });
    await expect(getPayout(pool, "pyo_synthetic_old_projector", "acc_synthetic_old_projector")).resolves.toMatchObject(
      expectedLegacyAmounts,
    );
    await expect(lookupPayoutBySupportId(pool, "pyo_synthetic_old_projector")).resolves.toMatchObject(
      expectedLegacyAmounts,
    );
    await expect(lookupPayoutBySupportReference(pool, "PYO-SYNTHOLD")).resolves.toMatchObject(expectedLegacyAmounts);
    await expect(queryLiabilitySnapshot(pool, "usd")).resolves.toMatchObject({
      inFlightPayoutDemandAmount: "91.00",
    });

    const current = await pool.query<{
      requested_amount: string;
      fee_amount: string;
      net_amount: string;
    }>(
      `SELECT requested_amount::text, fee_amount::text, net_amount::text
       FROM settlement_payout_pages
       WHERE payout_id = 'pyo_synthetic_current_fee'`,
    );
    expect(current.rows).toEqual([{ requested_amount: "50.00", fee_amount: "1.00", net_amount: "49.00" }]);
  });

  it("creates the marketplace label postage table identically from boot SQL and its ledgered migration", async () => {
    const pool = pools.settlement;
    const migration = settlementFulfillmentSourceSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260910_settlement_marketplace_label_postage",
    );
    expect(migration).toBeDefined();
    expect((settlementModule.schemaMigrations ?? []).map((candidate) => candidate.migrationId)).toContain(
      "20260910_settlement_marketplace_label_postage",
    );

    async function readShape() {
      const [columns, indexes, persistence] = await Promise.all([
        pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'settlement_marketplace_label_postage'
           ORDER BY ordinal_position`,
        ),
        pool.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = current_schema()
             AND tablename = 'settlement_marketplace_label_postage'
           ORDER BY indexname`,
        ),
        pool.query<{ relpersistence: string }>(
          `SELECT relpersistence
           FROM pg_class
           WHERE oid = 'settlement_marketplace_label_postage'::regclass`,
        ),
      ]);
      return { columns: columns.rows, indexes: indexes.rows, persistence: persistence.rows };
    }

    for (const statement of migration!.statements) {
      await pool.query(statement);
    }
    const migrationShape = await readShape();

    await resetMultiContextTestSchemas(pools);
    await pool.query(settlementFulfillmentSourceSchemaSql);
    const bootShape = await readShape();

    expect(migrationShape).toEqual(bootShape);
    expect(bootShape.persistence).toEqual([{ relpersistence: "u" }]);
    expect(bootShape.indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        "settlement_marketplace_label_postage_pkey",
        "settlement_marketplace_label_postage_provider_identity_idx",
        "settlement_marketplace_label_postage_operator_review_idx",
      ]),
    );
  });
});
