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
import type { MoneyAmount } from "@chase-sets/primitives/money";
import {
  MARKET_STAT_HYGIENE_COMPILED_REVISION_ID,
  MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID,
} from "../features/market-rollups/read-model/stat-hygiene-policy-revision";
import { buildPricingMarketTradesProjectionHandlers } from "../features/market-trades/integrations/source/source-projection";
import { buildPricingInventoryInputProjectionHandlers } from "../features/recommendations/integrations/source/source-projection";
import { composePricingInventoryEconomicsProjectionHandlers } from "../features/economics/integrations/inventory/projection";
import { deriveCostBasisFacts } from "../features/economics/domain/derivation";
import { ECONOMICS_LAUNCH_POLICY_VALUE, type ResolvedEconomicsPolicy } from "../features/economics/domain/policy";
import type { EconomicsEvidenceSnapshot } from "../features/economics/domain/resolution";
import {
  createPostgresEconomicsEvidenceReader,
  economicsInventoryCheckpointKey,
  economicsSalesCheckpointKey,
} from "../features/economics/read-model/evidence-queries";
import { buildEconomicsOverrideProjectionHandlers } from "../features/economics/read-model/override-projection";
import { readCurrentEconomicsOverrides } from "../features/economics/read-model/override-queries";
import { module as pricingModule } from "../index";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

function event(
  id: string,
  type: string,
  streamVersion: number,
  data: Record<string, unknown>,
  occurredAt: string,
  recordedAt: string,
) {
  return {
    id,
    type,
    streamId: `stream_${id}`,
    streamVersion,
    data,
    timing: { occurredAt, recordedAt },
  } as never;
}

describeDb("pricing schema upgrades", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["pricing"], "pricing_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("upgrades deployed pricing schema idempotently across two boots", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    // The deployed schema predates Own-Sale Observations. The current boot SQL
    // owns this additive table and must recreate it without a ledgered migration.
    await pool.query("DROP TABLE pricing_own_sale_observations");
    await pool.query("ALTER TABLE pricing_daily_product_rollups DROP COLUMN stat_hygiene_policy_revision_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260720_pricing_daily_rollup_policy_revision_binding'",
    );
    await pool.query("ALTER TABLE pricing_market_trade_rollup_rederive_queue DROP COLUMN generation");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260720_pricing_rollup_rederive_queue_generation'",
    );
    await pool.query("ALTER TABLE pricing_market_trades DROP COLUMN inventory_item_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260908_pricing_market_trades_inventory_item'",
    );
    await pool.query("DROP TABLE pricing_inventory_acquisition_lots");
    await pool.query("DROP TABLE pricing_economics_overrides");
    await pool.query(
      `DELETE FROM bounded_context_schema_migrations
       WHERE migration_id IN (
         '20260907_pricing_economics_acquisition_lots',
         '20260907_pricing_economics_overrides',
         '20260908_pricing_economics_unlogged_projections'
       )`,
    );
    await pool.query(
      `INSERT INTO pricing_daily_product_rollups (
         catalog_catalog_item_id, product_id, day, median_price_amount,
         unit_volume, trade_count, verified_trade_count, updated_at
       ) VALUES ('cat_deployed', 'prod_deployed', '2026-07-01', 15.00, 8, 8, 0, now())`,
    );

    await bootstrapContextDatabase(pricingModule, pool);
    await bootstrapContextDatabase(pricingModule, pool);

    const linkageTables = await pool.query<{ linkage_state: string; rederive_queue: string }>(
      `SELECT
         to_regclass('pricing_market_trade_linkage_clusters')::text AS linkage_state,
         to_regclass('pricing_market_trade_rollup_rederive_queue')::text AS rederive_queue`,
    );
    expect(linkageTables.rows).toEqual([
      {
        linkage_state: "pricing_market_trade_linkage_clusters",
        rederive_queue: "pricing_market_trade_rollup_rederive_queue",
      },
    ]);

    const ownSaleTable = await pool.query<{ own_sale_observations: string }>(
      `SELECT to_regclass('pricing_own_sale_observations')::text AS own_sale_observations`,
    );
    expect(ownSaleTable.rows).toEqual([{ own_sale_observations: "pricing_own_sale_observations" }]);

    const queueGeneration = await pool.query<{ generation_default: string; nullable: string }>(
      `SELECT column_default AS generation_default, is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pricing_market_trade_rollup_rederive_queue'
         AND column_name = 'generation'`,
    );
    expect(queueGeneration.rows).toEqual([{ generation_default: "1", nullable: "NO" }]);

    const deployed = await pool.query<{ stat_hygiene_policy_revision_id: string }>(
      `SELECT stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_deployed'`,
    );
    expect(deployed.rows).toEqual([
      { stat_hygiene_policy_revision_id: MARKET_STAT_HYGIENE_LEGACY_UNTRIMMED_REVISION_ID },
    ]);

    await pool.query(
      `INSERT INTO pricing_daily_product_rollups (
         catalog_catalog_item_id, product_id, day, median_price_amount,
         unit_volume, trade_count, verified_trade_count, updated_at
       ) VALUES ('cat_new', 'prod_new', '2026-07-02', 10.00, 8, 8, 0, now())`,
    );
    const fresh = await pool.query<{ stat_hygiene_policy_revision_id: string }>(
      `SELECT stat_hygiene_policy_revision_id
       FROM pricing_daily_product_rollups
       WHERE catalog_catalog_item_id = 'cat_new'`,
    );
    expect(fresh.rows).toEqual([{ stat_hygiene_policy_revision_id: MARKET_STAT_HYGIENE_COMPILED_REVISION_ID }]);

    const migration = await pool.query<{ applied_count: number }>(
      `SELECT COUNT(*)::integer AS applied_count
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260720_pricing_daily_rollup_policy_revision_binding'`,
    );
    expect(migration.rows).toEqual([{ applied_count: 1 }]);

    const generationMigration = await pool.query<{ applied_count: number }>(
      `SELECT COUNT(*)::integer AS applied_count
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260720_pricing_rollup_rederive_queue_generation'`,
    );
    expect(generationMigration.rows).toEqual([{ applied_count: 1 }]);

    const economicsUpgrade = await pool.query<{
      inventory_item_column: string;
      acquisition_lots: string;
      overrides: string;
      applied_count: number;
    }>(
      `SELECT
         (SELECT is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'pricing_market_trades'
            AND column_name = 'inventory_item_id') AS inventory_item_column,
         to_regclass('pricing_inventory_acquisition_lots')::text AS acquisition_lots,
         to_regclass('pricing_economics_overrides')::text AS overrides,
         (SELECT COUNT(*)::integer
          FROM bounded_context_schema_migrations
          WHERE migration_id IN (
            '20260908_pricing_market_trades_inventory_item',
            '20260907_pricing_economics_acquisition_lots',
            '20260907_pricing_economics_overrides',
            '20260908_pricing_economics_unlogged_projections'
          )) AS applied_count`,
    );
    expect(economicsUpgrade.rows).toEqual([
      {
        inventory_item_column: "YES",
        acquisition_lots: "pricing_inventory_acquisition_lots",
        overrides: "pricing_economics_overrides",
        applied_count: 4,
      },
    ]);

    const persistence = await pool.query<{ relname: string; relpersistence: string }>(
      `SELECT relname, relpersistence
       FROM pg_class
       WHERE relname IN (
         'pricing_external_catalog_item_reference_inputs',
         'pricing_external_market_captures',
         'pricing_external_sale_observations',
         'pricing_external_weekly_sale_buckets',
         'pricing_external_listing_snapshots',
         'pricing_external_listing_ask_depth',
         'pricing_inventory_acquisition_lots',
         'pricing_economics_overrides'
       )
       ORDER BY relname`,
    );
    expect(persistence.rows).toEqual([
      { relname: "pricing_economics_overrides", relpersistence: "u" },
      { relname: "pricing_external_catalog_item_reference_inputs", relpersistence: "u" },
      { relname: "pricing_external_listing_ask_depth", relpersistence: "p" },
      { relname: "pricing_external_listing_snapshots", relpersistence: "p" },
      { relname: "pricing_external_market_captures", relpersistence: "p" },
      { relname: "pricing_external_sale_observations", relpersistence: "p" },
      { relname: "pricing_external_weekly_sale_buckets", relpersistence: "p" },
      { relname: "pricing_inventory_acquisition_lots", relpersistence: "u" },
    ]);
  });

  it("persists explicit acquisition and sale occurrences for account-qualified Economics history", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    const inventoryHandlers = composePricingInventoryEconomicsProjectionHandlers(
      pool,
      buildPricingInventoryInputProjectionHandlers(pool),
    );
    const created = event(
      "evt_inventory",
      "inventory.item.created",
      1,
      {
        itemId: "item_1",
        accountId: "seller_1",
        catalogItemId: "cat_1",
        productId: "product_1",
        totalQuantity: 2,
        acquisitionCostAmount: "5.00",
        acquisitionCostCurrencyCode: "USD",
        acquisitionOccurrence: {
          kind: "occurred",
          occurredAt: "2026-08-01T09:00:00.000Z",
          source: "import-supplied",
        },
      },
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:00:05.000Z",
    );
    await inventoryHandlers["inventory.item.created"]!(created);
    const cleanFirstWrite = await pool.query(
      `SELECT account_id, inventory_item_id, event_stream_version, quantity, occurrence_kind,
              acquired_at::text, occurrence_source, last_source_event_id, last_source_event_recorded_at::text
       FROM pricing_inventory_acquisition_lots`,
    );
    expect(cleanFirstWrite.rows).toEqual([
      {
        account_id: "seller_1",
        inventory_item_id: "item_1",
        event_stream_version: 1,
        quantity: 2,
        occurrence_kind: "occurred",
        acquired_at: "2026-08-01 09:00:00+00",
        occurrence_source: "import-supplied",
        last_source_event_id: "evt_inventory",
        last_source_event_recorded_at: "2026-09-01 10:00:05+00",
      },
    ]);
    await inventoryHandlers["inventory.item.created"]!(created);
    const exactReplay = await pool.query(
      `SELECT account_id, inventory_item_id, event_stream_version, quantity, occurrence_kind,
              acquired_at::text, occurrence_source, last_source_event_id, last_source_event_recorded_at::text
       FROM pricing_inventory_acquisition_lots`,
    );
    expect(exactReplay.rows).toEqual(cleanFirstWrite.rows);
    await expect(
      inventoryHandlers["inventory.item.created"]!(
        event(
          "evt_inventory_conflict",
          "inventory.item.created",
          1,
          {
            itemId: "item_1",
            accountId: "seller_1",
            catalogItemId: "cat_1",
            productId: "product_1",
            totalQuantity: 2,
            acquisitionCostAmount: "5.00",
            acquisitionOccurrence: { kind: "unknown" },
          },
          "2026-09-01T10:00:00.000Z",
          "2026-09-01T10:00:06.000Z",
        ),
      ),
    ).rejects.toThrow(/conflicts with a different source event/);
    const conflictingSourceRefused = await pool.query(
      `SELECT account_id, inventory_item_id, event_stream_version, quantity, occurrence_kind,
              acquired_at::text, occurrence_source, last_source_event_id, last_source_event_recorded_at::text
       FROM pricing_inventory_acquisition_lots`,
    );
    expect(conflictingSourceRefused.rows).toEqual(cleanFirstWrite.rows);
    await inventoryHandlers["inventory.item.adjusted"]!(
      event(
        "evt_adjust_unknown",
        "inventory.item.adjusted",
        2,
        { itemId: "item_1", quantityDelta: 1 },
        "2026-09-02T10:00:00.000Z",
        "2026-09-02T10:00:05.000Z",
      ),
    );
    await inventoryHandlers["inventory.item.adjusted"]!(
      event(
        "evt_adjust_negative",
        "inventory.item.adjusted",
        3,
        { itemId: "item_1", quantityDelta: -1, acquisitionOccurrence: { kind: "unknown" } },
        "2026-09-03T10:00:00.000Z",
        "2026-09-03T10:00:05.000Z",
      ),
    );

    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.created"]!(
      event(
        "evt_order",
        "ordering.order.created",
        1,
        {
          orderId: "order_1",
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_1",
          sellerAccountId: "seller_1",
          lines: [
            {
              lineId: "line_1",
              inventoryItemId: "item_1",
              catalogItemId: "cat_1",
              productId: "product_1",
              unitPriceAmount: "10.00",
              quantity: 1,
            },
          ],
        },
        "2026-09-05T12:00:00.000Z",
        "2026-09-05T12:00:01.000Z",
      ),
    );
    await tradeHandlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event(
        "evt_ready",
        "ordering.order.ready-for-fulfillment-recorded",
        2,
        { orderId: "order_1", readyForFulfillmentAt: "2026-09-05T12:30:00.000Z" },
        "2026-09-05T12:30:00.000Z",
        "2026-09-05T12:45:00.000Z",
      ),
    );
    await pool.query(
      `INSERT INTO event_subscription_checkpoints (
         checkpoint_key, projection_name, source_context_name, subscription_version,
         last_global_position, lease_owner_id, lease_fencing_token, updated_at
       ) VALUES
         ($1, 'pricing-inventory-input-projection', 'inventory', 3, 41, NULL, NULL, '2026-09-05T13:00:00.000Z'),
         ($2, 'pricing-market-trades-projection', 'ordering', 2, 57, NULL, NULL, '2026-09-05T13:05:00.000Z')`,
      [economicsInventoryCheckpointKey, economicsSalesCheckpointKey],
    );

    const evidence = await createPostgresEconomicsEvidenceReader(pool).resolve({
      accountId: "seller_1",
      connectionId: "connection_1",
      catalogItemId: "cat_1",
      inventoryItemId: "item_1",
      marketUnitPrice: { amount: "10.00" as MoneyAmount, currency: "usd" },
      quantity: 1,
      effectiveAt: "2026-09-06T00:00:00.000Z",
    });

    expect(evidence.acquisitions).toMatchObject([
      {
        accountId: "seller_1",
        inventoryItemId: "item_1",
        quantity: 2,
        occurrence: {
          kind: "occurred",
          occurredAt: "2026-08-01T09:00:00.000Z",
          source: "import-supplied",
        },
      },
      { accountId: "seller_1", inventoryItemId: "item_1", quantity: 1, occurrence: { kind: "unknown" } },
    ]);
    expect(evidence.sales).toEqual([
      {
        accountId: "seller_1",
        inventoryItemId: "item_1",
        saleId: "order_1:line_1",
        quantity: 1,
        soldAt: "2026-09-05T12:30:00.000Z",
        currency: "usd",
        excluded: false,
      },
    ]);
    expect(evidence.costLots).toMatchObject([
      {
        accountId: "seller_1",
        inventoryItemId: "item_1",
        quantity: 2,
        acquisitionCostPerUnit: { amount: "5.00", currency: "usd" },
        observedAt: "2026-09-03T10:00:05.000Z",
      },
    ]);
    expect(evidence).toMatchObject({
      inventoryWatermark: `${economicsInventoryCheckpointKey}@41`,
      pricingWatermark: `${economicsSalesCheckpointKey}@57`,
      inventoryObservedAt: "2026-09-05T13:00:00.000Z",
      pricingObservedAt: "2026-09-05T13:05:00.000Z",
    });

    const acquisitionRows = await pool.query<{
      event_stream_version: number;
      occurrence_kind: string;
      acquired_at: string | null;
      last_source_event_recorded_at: string;
    }>(
      `SELECT event_stream_version, occurrence_kind, acquired_at::text, last_source_event_recorded_at::text
       FROM pricing_inventory_acquisition_lots
       ORDER BY event_stream_version`,
    );
    expect(acquisitionRows.rows).toEqual([
      {
        event_stream_version: 1,
        occurrence_kind: "occurred",
        acquired_at: "2026-08-01 09:00:00+00",
        last_source_event_recorded_at: "2026-09-01 10:00:05+00",
      },
      {
        event_stream_version: 2,
        occurrence_kind: "unknown",
        acquired_at: null,
        last_source_event_recorded_at: "2026-09-02 10:00:05+00",
      },
    ]);
  });

  it("keeps Inventory cost denomination authoritative through the upgraded schema", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    await pool.query(
      `INSERT INTO pricing_inventory_item_inputs (
         item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity,
         acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version
       ) VALUES
         ('item_usd', 'seller_1', 'cat_usd', 'product_usd', 1, 71.70, 'USD', '2026-09-01T11:00:00Z', 4),
         ('item_legacy', 'seller_1', 'cat_legacy', 'product_legacy', 1, 71.70, NULL, '2026-09-01T11:00:00Z', 4)`,
    );

    const reader = createPostgresEconomicsEvidenceReader(pool);
    const requestFor = (inventoryItemId: string, catalogItemId: string, currency: string) => ({
      accountId: "seller_1",
      connectionId: "synthetic-connection",
      catalogItemId,
      inventoryItemId,
      marketUnitPrice: { amount: "100.00" as MoneyAmount, currency },
      quantity: 1,
      effectiveAt: "2026-09-06T00:00:00.000Z",
    });
    const usdRequest = requestFor("item_usd", "cat_usd", "usd");
    const eurRequest = requestFor("item_usd", "cat_usd", "eur");
    const legacyRequest = requestFor("item_legacy", "cat_legacy", "usd");
    const [sameCurrency, mismatchedCurrency, legacyNullCurrency] = await Promise.all([
      reader.resolve(usdRequest),
      reader.resolve(eurRequest),
      reader.resolve(legacyRequest),
    ]);

    expect(sameCurrency.costLots[0]?.acquisitionCostPerUnit).toEqual({ amount: "71.70", currency: "usd" });
    expect(deriveDbCostFacts(sameCurrency, usdRequest)).toMatchObject({ coveredQuantity: 1, selectedQuantity: 1 });
    expect(mismatchedCurrency.costLots[0]?.acquisitionCostPerUnit).toEqual({ amount: "71.70", currency: "usd" });
    expect(mismatchedCurrency.costLots[0]?.revision).toBe(sameCurrency.costLots[0]?.revision);
    expect(deriveDbCostFacts(mismatchedCurrency, eurRequest)).toMatchObject({
      coveredQuantity: 0,
      selectedQuantity: 1,
    });
    expect(legacyNullCurrency.costLots[0]?.acquisitionCostPerUnit).toBeNull();
    expect(deriveDbCostFacts(legacyNullCurrency, legacyRequest)).toMatchObject({
      coveredQuantity: 0,
      selectedQuantity: 1,
    });
  });

  it("keeps override tombstones monotonic under duplicate and stale delivery", async () => {
    const pool = pools.pricing;
    await bootstrapContextDatabase(pricingModule, pool);
    const handlers = buildEconomicsOverrideProjectionHandlers(pool);
    const key = { accountId: "seller_1", connectionId: "connection_1", currency: "usd" };
    const set = event(
      "evt_set",
      "pricing.economics-fact-override-set",
      1,
      {
        ...key,
        factName: "platformFeeCapPerUnitAmount",
        value: null,
        occurredAt: "2026-09-01T10:00:00.000Z",
      },
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:00:01.000Z",
    );
    await handlers["pricing.economics-fact-override-set"]!(set);
    await handlers["pricing.economics-fact-override-set"]!(set);
    const clear = event(
      "evt_clear",
      "pricing.economics-fact-override-cleared",
      2,
      {
        ...key,
        factName: "platformFeeCapPerUnitAmount",
        value: null,
        occurredAt: "2026-09-02T10:00:00.000Z",
      },
      "2026-09-02T10:00:00.000Z",
      "2026-09-02T10:00:01.000Z",
    );
    await handlers["pricing.economics-fact-override-cleared"]!(clear);
    await handlers["pricing.economics-fact-override-set"]!(set);

    const state = await readCurrentEconomicsOverrides(pool, key);
    expect(state).toMatchObject({
      version: 2,
      lastChangedAt: "2026-09-02T10:00:00.000Z",
      entries: {
        platformFeeCapPerUnitAmount: {
          kind: "cleared",
          value: null,
          revision: 2,
          setAt: null,
          clearedAt: "2026-09-02T10:00:00.000Z",
        },
      },
    });
  });
});

const syntheticEconomicsPolicy: ResolvedEconomicsPolicy = {
  value: ECONOMICS_LAUNCH_POLICY_VALUE,
  policyRevision: "sha256:synthetic-policy-revision",
  observedAt: "2026-09-06T20:28:41Z",
  source: "fallback",
  documentId: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

function deriveDbCostFacts(
  evidence: EconomicsEvidenceSnapshot,
  request: Parameters<ReturnType<typeof createPostgresEconomicsEvidenceReader>["resolve"]>[0],
) {
  return deriveCostBasisFacts({
    accountId: request.accountId,
    inventoryItemId: request.inventoryItemId,
    marketUnitPrice: request.marketUnitPrice,
    quantity: request.quantity,
    effectiveAt: request.effectiveAt,
    inventoryWatermark: evidence.inventoryWatermark,
    inventoryObservedAt: evidence.inventoryObservedAt,
    lots: evidence.costLots,
    policy: syntheticEconomicsPolicy,
  });
}
