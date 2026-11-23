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
import { settlementPayoutReviewHoldFallbackGuardMigrationId } from "../features/wallets/integrations/account-risk-source/account-risk-source-schema";
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

  const previousModule = {
    ...settlementModule,
    schemaMigrations: settlementModule.schemaMigrations!.filter(
      (migration) => migration.migrationId !== settlementPayoutReviewHoldFallbackGuardMigrationId,
    ),
  };

  it("adds the ledger-only risk revision with exact fresh and retained catalogs and skips it on second boot", async () => {
    const pool = pools.settlement;
    const migrationId = "20261104_settlement_account_risk_source_revision";
    const catalog = async () =>
      (
        await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'settlement_account_risk_sources'
          AND column_name = 'revision'`)
      ).rows;
    const expected = [{ data_type: "bigint", is_nullable: "NO", column_default: "0" }];
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await catalog()).toEqual(expected);
    await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, revision, updated_at)
      VALUES ('acc_schema_revision', 7, '2026-11-04T00:00:00.000Z')`);
    const ledger = async () =>
      (await pool.query("SELECT * FROM bounded_context_schema_migrations WHERE migration_id = $1", [migrationId])).rows;
    const applied = await ledger();
    expect(applied).toHaveLength(1);
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await ledger()).toEqual(applied);
    expect((await pool.query("SELECT revision::text FROM settlement_account_risk_sources")).rows).toEqual([
      { revision: "7" },
    ]);

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(
      {
        ...settlementModule,
        schemaMigrations: settlementModule.schemaMigrations!.filter(
          (migration) => migration.migrationId !== migrationId,
        ),
      },
      pool,
    );
    expect(await catalog()).toEqual([]);
    await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, trusted_seller, updated_at)
      VALUES ('acc_schema_revision', true, '2026-11-04T00:00:00.000Z')`);
    const before = (await pool.query("SELECT * FROM settlement_account_risk_sources")).rows;
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await catalog()).toEqual(expected);
    expect((await pool.query("SELECT * FROM settlement_account_risk_sources")).rows).toEqual(
      before.map((row) => ({ ...row, revision: "0" })),
    );
    const retainedLedger = await ledger();
    expect(retainedLedger).toHaveLength(1);
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await ledger()).toEqual(retainedLedger);
    expect(await catalog()).toEqual(expected);
    expect((await pool.query("SELECT * FROM settlement_account_risk_sources")).rows).toEqual(
      before.map((row) => ({ ...row, revision: "0" })),
    );
  });

  it("adds payout review hold columns on retained rows without changing the badge or revision", async () => {
    const pool = pools.settlement;
    const migrationId = "20261120_settlement_payout_review_hold";
    await bootstrapContextDatabase(
      {
        ...previousModule,
        schemaMigrations: previousModule.schemaMigrations.filter((migration) => migration.migrationId !== migrationId),
      },
      pool,
    );
    await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, manual_payout_review, revision)
      VALUES ('acc_payout_review_hold_upgrade', true, 7)`);
    await bootstrapContextDatabase(previousModule, pool);
    const read = async () =>
      (
        await pool.query(
          `SELECT manual_payout_review, revision, payout_review_hold, payout_review_hold_stream_version
         FROM settlement_account_risk_sources WHERE account_id = 'acc_payout_review_hold_upgrade'`,
        )
      ).rows;
    expect(await read()).toEqual([
      { manual_payout_review: true, revision: "7", payout_review_hold: false, payout_review_hold_stream_version: "0" },
    ]);
    await pool.query(`UPDATE settlement_account_risk_sources
      SET payout_review_hold = true, payout_review_hold_stream_version = 1
      WHERE account_id = 'acc_payout_review_hold_upgrade'`);
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await read()).toEqual([
      { manual_payout_review: true, revision: "7", payout_review_hold: true, payout_review_hold_stream_version: "1" },
    ]);
  });

  it("fallback guard refuses unmigrated rows and keeps the column", async () => {
    const pool = pools.settlement;
    const ledger = async () =>
      (
        await pool.query("SELECT * FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          settlementPayoutReviewHoldFallbackGuardMigrationId,
        ])
      ).rows;
    await bootstrapContextDatabase(previousModule, pool);
    await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, manual_payout_review)
      VALUES ('acc_unmigrated_badge', true)`);
    await expect(bootstrapContextDatabase(settlementModule, pool)).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining("unmigrated manual payout review badges remain"),
    });
    expect(await ledger()).toEqual([]);

    await pool.query(`UPDATE settlement_account_risk_sources SET payout_review_hold_stream_version = 1
      WHERE account_id = 'acc_unmigrated_badge'`);
    await bootstrapContextDatabase(settlementModule, pool);
    const applied = await ledger();
    expect(applied).toHaveLength(1);
    expect((await pool.query("SELECT manual_payout_review FROM settlement_account_risk_sources")).rows).toEqual([
      { manual_payout_review: true },
    ]);
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await ledger()).toEqual(applied);

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(previousModule, pool);
    await pool.query("ALTER TABLE settlement_account_risk_sources DROP COLUMN manual_payout_review");
    await bootstrapContextDatabase(settlementModule, pool);
    expect(await ledger()).toHaveLength(1);
    await expect(pool.query("SELECT manual_payout_review FROM settlement_account_risk_sources")).rejects.toMatchObject({
      code: "42703",
    });
  });

  describe("account velocity storage drop", () => {
    const migrationId = "20261123_settlement_drop_account_velocity_storage";
    const velocityTable = "settlement_account_velocity_sources";
    const velocityColumns = [
      "buyer_order_24h_count",
      "buyer_spend_24h_cents",
      "chargeback_30d_count",
      "chargeback_30d_rate_bps",
      "chargeback_7d_count",
      "listing_24h_count",
      "listing_24h_value_cents",
      "review_24h_count",
      "review_24h_median_reviewer_age_days",
      "velocity_alert_flags",
    ];
    const retiredMigrationIds = [
      "20260707_settlement_account_velocity_risk_sources",
      "20260907_settlement_listing_risk_currency",
    ];
    // The storage as the last boot SQL that declared it left it on a retained database.
    const retainedVelocityStorageSql = `
CREATE TABLE IF NOT EXISTS settlement_account_velocity_sources (
  source_kind text NOT NULL,
  source_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL DEFAULT 0,
  amount_currency_code text NULL,
  source_stream_version integer NULL,
  reviewer_account_id text NULL,
  reviewer_account_created_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (source_kind, source_id, account_id)
);

CREATE INDEX IF NOT EXISTS settlement_account_velocity_sources_account_window_idx
  ON settlement_account_velocity_sources (account_id, source_kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS settlement_account_velocity_sources_reviewer_idx
  ON settlement_account_velocity_sources (reviewer_account_id)
  WHERE reviewer_account_id IS NOT NULL;

ALTER TABLE settlement_account_velocity_sources SET UNLOGGED;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_7d_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_30d_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS chargeback_30d_rate_bps integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS listing_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS listing_24h_value_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS review_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS review_24h_median_reviewer_age_days numeric(10, 2) NULL;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS buyer_order_24h_count integer NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS buyer_spend_24h_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE settlement_account_risk_sources
  ADD COLUMN IF NOT EXISTS velocity_alert_flags jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

    const catalog = async () => {
      const pool = pools.settlement;
      const [tables, indexes, riskSourceColumns] = await Promise.all([
        pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = current_schema()
           ORDER BY table_name`,
        ),
        pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = current_schema()
           ORDER BY indexname`,
        ),
        pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'settlement_account_risk_sources'
           ORDER BY column_name`,
        ),
      ]);
      return {
        tables: tables.rows.map((row) => row.table_name),
        indexes: indexes.rows.map((row) => row.indexname),
        riskSourceColumns: riskSourceColumns.rows,
      };
    };
    const velocityObjects = (shape: Awaited<ReturnType<typeof catalog>>) => ({
      tables: shape.tables.filter((name) => name === velocityTable),
      indexes: shape.indexes.filter((name) => name.startsWith(velocityTable)).sort(),
      columns: shape.riskSourceColumns
        .map((column) => column.column_name)
        .filter((name) => velocityColumns.includes(name))
        .sort(),
    });
    const ledger = async () =>
      (
        await pools.settlement.query("SELECT * FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows;
    const riskSourceRows = async () =>
      (await pools.settlement.query("SELECT * FROM settlement_account_risk_sources ORDER BY account_id")).rows;
    const retiredLedgerIds = async () =>
      (
        await pools.settlement.query<{ migration_id: string }>(
          `SELECT migration_id FROM bounded_context_schema_migrations
           WHERE migration_id = ANY($1::text[])
           ORDER BY migration_id`,
          [retiredMigrationIds],
        )
      ).rows.map((row) => row.migration_id);
    const bootstrapBeforeTheDrop = () =>
      bootstrapContextDatabase(
        {
          ...settlementModule,
          schemaMigrations: settlementModule.schemaMigrations!.filter(
            (migration) => migration.migrationId !== migrationId,
          ),
        },
        pools.settlement,
      );

    it("bootstraps a fresh database without the storage, records the drop and changes nothing on a second boot", async () => {
      const pool = pools.settlement;
      await bootstrapContextDatabase(settlementModule, pool);
      const fresh = await catalog();
      expect(velocityObjects(fresh)).toEqual({ tables: [], indexes: [], columns: [] });
      expect(fresh.riskSourceColumns.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(["account_id", "revision", "payout_review_hold", "updated_at"]),
      );
      const applied = await ledger();
      expect(applied).toHaveLength(1);
      expect(await retiredLedgerIds()).toEqual([]);

      await bootstrapContextDatabase(settlementModule, pool);
      expect(await catalog()).toEqual(fresh);
      expect(await ledger()).toEqual(applied);
      expect(await retiredLedgerIds()).toEqual([]);
    });

    it("drops exactly the retained storage, keeps every other risk source fact and restores nothing on a second boot", async () => {
      const pool = pools.settlement;
      await bootstrapBeforeTheDrop();
      const withoutStorage = await catalog();
      expect(velocityObjects(withoutStorage)).toEqual({ tables: [], indexes: [], columns: [] });

      await pool.query(retainedVelocityStorageSql);
      await pool.query(
        `INSERT INTO bounded_context_schema_migrations (migration_id, description)
         SELECT retired.migration_id, 'Applied by a release that still declared the velocity storage.'
         FROM unnest($1::text[]) AS retired (migration_id)`,
        [retiredMigrationIds],
      );
      await pool.query(`INSERT INTO settlement_account_risk_sources (
          account_id, account_created_at, trusted_seller, stripe_fraud_signal_count, review_count, average_rating,
          updated_at, revision, payout_review_hold, payout_review_hold_stream_version,
          chargeback_7d_count, chargeback_30d_count, chargeback_30d_rate_bps, listing_24h_count,
          listing_24h_value_cents, review_24h_count, review_24h_median_reviewer_age_days, buyer_order_24h_count,
          buyer_spend_24h_cents, velocity_alert_flags
        ) VALUES (
          'acc_velocity_counters', '2026-07-01T00:00:00.000Z', true, 2, 5, 4.50,
          '2026-11-20T00:00:00.000Z', 7, true, 3,
          1, 2, 250, 4,
          125000, 6, 1.50, 8,
          990000, '["chargeback-rate"]'::jsonb
        )`);
      await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, updated_at, revision)
        VALUES ('acc_velocity_defaults', '2026-11-21T00:00:00.000Z', 1)`);
      await pool.query(`INSERT INTO settlement_account_velocity_sources (
          source_kind, source_id, account_id, occurred_at, amount_cents, amount_currency_code,
          source_stream_version, reviewer_account_id, reviewer_account_created_at, updated_at
        ) VALUES (
          'listing-created', 'lst_velocity', 'acc_velocity_counters', '2026-11-19T00:00:00.000Z', 125000, 'usd',
          4, NULL, NULL, '2026-11-19T00:00:00.000Z'
        ), (
          'review-received', 'rev_velocity', 'acc_velocity_counters', '2026-11-19T00:00:00.000Z', 0, NULL,
          NULL, 'acc_velocity_reviewer', '2026-11-18T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
        )`);

      expect(velocityObjects(await catalog())).toEqual({
        tables: [velocityTable],
        indexes: [`${velocityTable}_account_window_idx`, `${velocityTable}_pkey`, `${velocityTable}_reviewer_idx`],
        columns: velocityColumns,
      });
      expect(
        (await pool.query("SELECT count(*)::integer AS count FROM settlement_account_velocity_sources")).rows,
      ).toEqual([{ count: 2 }]);
      const before = await riskSourceRows();
      expect(before).toMatchObject([
        {
          account_id: "acc_velocity_counters",
          trusted_seller: true,
          revision: "7",
          payout_review_hold: true,
          payout_review_hold_stream_version: "3",
          chargeback_30d_rate_bps: 250,
          listing_24h_value_cents: "125000",
          review_24h_median_reviewer_age_days: "1.50",
          velocity_alert_flags: ["chargeback-rate"],
        },
        { account_id: "acc_velocity_defaults", revision: "1", chargeback_7d_count: 0, velocity_alert_flags: [] },
      ]);
      const retained = before.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([name]) => !velocityColumns.includes(name))),
      );
      expect(await ledger()).toEqual([]);

      await bootstrapContextDatabase(settlementModule, pool);
      expect(await catalog()).toEqual(withoutStorage);
      expect(await riskSourceRows()).toEqual(retained);
      const applied = await ledger();
      expect(applied).toHaveLength(1);

      await bootstrapContextDatabase(settlementModule, pool);
      expect(await catalog()).toEqual(withoutStorage);
      expect(await riskSourceRows()).toEqual(retained);
      expect(await ledger()).toEqual(applied);
      expect(await retiredLedgerIds()).toEqual(retiredMigrationIds);
    });

    // A drop that stopped between its statements leaves one half of the storage and no ledger row.
    it.each([
      {
        remaining: "the counters",
        removeTheOtherHalf: `DROP TABLE ${velocityTable}`,
        expected: { tables: [], indexes: [], columns: velocityColumns },
      },
      {
        remaining: "the table",
        removeTheOtherHalf: `ALTER TABLE settlement_account_risk_sources ${velocityColumns
          .map((column) => `DROP COLUMN ${column}`)
          .join(", ")}`,
        expected: {
          tables: [velocityTable],
          indexes: [`${velocityTable}_account_window_idx`, `${velocityTable}_pkey`, `${velocityTable}_reviewer_idx`],
          columns: [],
        },
      },
    ])(
      "finishes a drop that left only $remaining, keeps the other risk source facts and records it once",
      async ({ removeTheOtherHalf, expected }) => {
        const pool = pools.settlement;
        await bootstrapBeforeTheDrop();
        const withoutStorage = await catalog();

        await pool.query(retainedVelocityStorageSql);
        await pool.query(removeTheOtherHalf);
        await pool.query(`INSERT INTO settlement_account_risk_sources (account_id, trusted_seller, updated_at, revision)
          VALUES ('acc_velocity_partial', true, '2026-11-22T00:00:00.000Z', 4)`);
        expect(velocityObjects(await catalog())).toEqual(expected);
        const retained = (await riskSourceRows()).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([name]) => !velocityColumns.includes(name))),
        );
        expect(retained).toMatchObject([{ account_id: "acc_velocity_partial", trusted_seller: true, revision: "4" }]);
        expect(await ledger()).toEqual([]);

        await bootstrapContextDatabase(settlementModule, pool);
        expect(await catalog()).toEqual(withoutStorage);
        expect(await riskSourceRows()).toEqual(retained);
        const applied = await ledger();
        expect(applied).toHaveLength(1);

        await bootstrapContextDatabase(settlementModule, pool);
        expect(await catalog()).toEqual(withoutStorage);
        expect(await riskSourceRows()).toEqual(retained);
        expect(await ledger()).toEqual(applied);
      },
    );
  });

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

    async function readTableShape(tableName: string) {
      const [columns, indexes, persistence] = await Promise.all([
        pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = $1
           ORDER BY ordinal_position`,
          [tableName],
        ),
        pool.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = current_schema()
             AND tablename = $1
           ORDER BY indexname`,
          [tableName],
        ),
        pool.query<{ relpersistence: string }>(
          `SELECT relpersistence
           FROM pg_class
           WHERE oid = $1::regclass`,
          [tableName],
        ),
      ]);
      return { columns: columns.rows, indexes: indexes.rows, persistence: persistence.rows };
    }

    async function readShape() {
      return {
        activation: await readTableShape("settlement_marketplace_label_postage_activation"),
        projection: await readTableShape("settlement_marketplace_label_postage"),
      };
    }

    for (const statement of migration!.statements) {
      await pool.query(statement);
    }
    const migrationShape = await readShape();

    await resetMultiContextTestSchemas(pools);
    await pool.query(settlementFulfillmentSourceSchemaSql);
    const bootShape = await readShape();

    expect(migrationShape).toEqual(bootShape);
    expect(bootShape.activation.persistence).toEqual([{ relpersistence: "p" }]);
    expect(bootShape.activation.indexes.map((index) => index.indexname)).toEqual([
      "settlement_marketplace_label_postage_activation_pkey",
    ]);
    expect(bootShape.projection.persistence).toEqual([{ relpersistence: "u" }]);
    expect(bootShape.projection.indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        "settlement_marketplace_label_postage_pkey",
        "settlement_marketplace_label_postage_provider_identity_idx",
        "settlement_marketplace_label_postage_operator_review_idx",
      ]),
    );
  });
});
