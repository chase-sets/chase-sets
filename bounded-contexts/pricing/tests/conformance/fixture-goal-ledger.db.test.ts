import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { module as pricingModule } from "../../index";
import { createForecastLedgerRuntime } from "../../features/forecast-ledger/api/runtime";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
} from "../../features/repricing-engine/domain/fact";
import {
  createRepricingEngineRuntime,
  type RepricingMarketplaceGateway,
} from "../../features/repricing-engine/api/runtime";
import { goalDirective } from "../../features/repricing-engine/tests/curve-objective-fixture";
import { dryRunContext, seedDryRunListings } from "../../features/repricing-engine/tests/dry-run-fixture";
import { economicsNeverResolved } from "../../features/repricing-engine/tests/round-capture-fixture";
import { registerShadowGoals } from "../../features/repricing-engine/tests/shadow-goal-fixture";
import { defineFixtureFlatOffsetGoal, fixtureFlatOffsetGoal } from "./fixture-flat-offset";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

type LedgerRow = Readonly<{
  listing_id: string;
  role: "incumbent" | "shadow";
  goal_id: string;
  goal_version: number;
  curve_version: string | null;
  forecasts: Readonly<Record<string, Readonly<{ medianSellDays: number; model: string }>>>;
}>;

describeDb("the fixture goal reaches the Forecast Ledger projection", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "fixture_goal_ledger_9709");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => closeMultiContextTestPools(pools));

  async function seed() {
    const pool = pools.pricing;
    await resetMultiContextTestSchemas(pools);
    await pool.query(pricingModule.schemaSql);
    await seedDryRunListings(pool, 3, 1);
    await pool.query(
      "UPDATE pricing_market_listing_inputs SET quantity_cap = 4 WHERE listing_id = 'lst_7910_00000003'",
    );
    const directive = goalDirective({
      anchorChain: [
        {
          source: "curve-objective",
          goalId: fixtureFlatOffsetGoal.id,
          goalVersion: fixtureFlatOffsetGoal.version,
          parameters: { offsetPercentiles: 10 },
        },
      ],
    });
    await pool.query(
      `INSERT INTO pricing_repricing_policies
       (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
       VALUES ('rpp_fixture_ledger', 'acc_7910', 'Fixture Ledger', 'active', 'all-listings', $1::jsonb, 10, $2, $2)`,
      [JSON.stringify([{ conditions: [], directive }]), "2026-10-13T12:00:00.000Z"],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_versions
       (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
        model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
        supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
       VALUES ('cat_00000000', 'prod_00000000', 1, 'Near Mint', 'Normal', 'English', 'fixture-ledger', 'fixture-builder-v1', 'synthetic',
        'synthetic', NULL, 'history-window', 'synthetic', 'observed', true, '2026-10-13T11:00:00Z', 'USD', '2100-01-01')`,
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_points
       (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
        competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
       VALUES ('cat_00000000', 'prod_00000000', 1, 10, 5.00, 2, 3, 0.5, 5, 9, false, false, 'observed'),
              ('cat_00000000', 'prod_00000000', 1, 65, 12.00, 5, 4, 0.5, 20, 6, false, false, 'observed'),
              ('cat_00000000', 'prod_00000000', 1, 90, 30.00, 10, 2, 0.25, 60, 3, false, false, 'observed')`,
    );
    await pool.query(
      `INSERT INTO pricing_external_market_captures
       (capture_id, provider_key, catalog_item_id, external_key, signal_pass_started_at, signal_policy_revision_id,
        products_per_pass, capture_started_at, capture_completed_at, authenticated_request, recorded_signal_count,
        unresolved_signal_count, outcome_kind, rejected_row_count)
       VALUES ('cap_fixture_ledger', 'tcgplayer', 'cat_00000000', 'ext_fixture_ledger', now(), 'synthetic', 1, now(), now(), false, 0, 0, 'recorded', 0)`,
    );
    await pool.query(
      `INSERT INTO pricing_external_weekly_sale_buckets
       (provider_key, external_key, catalog_item_id, catalog_product_key, week_start, provider_condition,
        provider_variant, provider_language, transaction_count, quantity_sold, last_capture_id, last_observed_at, updated_at)
       VALUES ('tcgplayer', 'ext_fixture_ledger', 'cat_00000000', 'prod_00000000', '2026-10-01', 'Near Mint', 'Normal', 'English', 2, 2, 'cap_fixture_ledger', now(), now()),
              ('tcgplayer', 'ext_fixture_ledger', 'cat_00000000', 'prod_00000000', '2026-09-24', 'Near Mint', 'Normal', 'English', 1, 1, 'cap_fixture_ledger', now(), now())`,
    );
  }

  it("Step 11 — Project the fixture goal's incumbent and shadow traces to the Forecast Ledger", async () => {
    await seed();
    registerShadowGoals([defineFixtureFlatOffsetGoal(1, 50), defineFixtureFlatOffsetGoal(2, 55)]);
    const pool = pools.pricing;
    const eventStore = createPostgresEventStore({ pool });
    const engine = createRepricingEngineRuntime({ db: pool, eventStore, economics: economicsNeverResolved });
    const gateway: RepricingMarketplaceGateway = {
      applyBulkListingPriceUpdates: vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(
        async ({ updates }) => ({
          items: updates.map((item) => ({ listingId: item.listingId, outcome: "applied" as const })),
        }),
      ),
      pauseListing: vi.fn(async () => undefined),
      publishListing: vi.fn(async () => undefined),
    };
    await engine.enqueueMarketPriceSignal({
      catalogItemId: "cat_00000000",
      productId: "prod_00000000",
      amount: "12.00",
      previousAmount: "10.00",
      context: dryRunContext,
      trigger: {
        kind: "market-price-estimated",
        eventId: "fixture-ledger-signal",
        signalVersion: "1",
        occurredAt: "2026-10-13T12:00:00.000Z",
      },
    });
    expect(
      await engine.processNextEvaluationJob({
        claimOwnerId: "fixture-ledger",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway,
      }),
    ).toBe(1);
    const event = (await eventStore.readAll()).find((entry) => entry.eventType === repricingPolicyEvaluatedEventType)!;
    const data = event.payload as RepricingPolicyEvaluatedEvent["data"];

    const policies = createPolicyRuntime({ eventStore, db: pool });
    const ledger = createForecastLedgerRuntime({
      pool,
      eventStore,
      policies,
      goalDefinitions: () => [fixtureFlatOffsetGoal, defineFixtureFlatOffsetGoal(2, 55)],
    });
    const handler = ledger.projectors[0]!.handlers[event.eventType]!;
    await handler(toTransportEvent(event));
    const rows = (
      await pool.query<LedgerRow>(
        `SELECT listing_id, role, goal_id, goal_version, curve_version::text, forecasts
       FROM pricing_forecast_ledger_entries ORDER BY listing_id, role`,
      )
    ).rows;
    expect(rows).toHaveLength(data.listings.length * 2);
    for (const row of rows) {
      expect(row).toMatchObject({ goal_id: fixtureFlatOffsetGoal.id, curve_version: "1" });
      expect([1, 2]).toContain(row.goal_version);
      expect(Object.keys(row.forecasts).sort()).toEqual(["buyer-choice", "condition-rate", "curve"]);
      for (const forecast of Object.values(row.forecasts)) {
        expect(forecast.medianSellDays).toBeGreaterThan(0);
        expect(forecast.model.length).toBeGreaterThan(0);
      }
    }
  });
});
