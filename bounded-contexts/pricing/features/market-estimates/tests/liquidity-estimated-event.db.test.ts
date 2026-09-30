import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { getDemandCurve, listDemandCurvePoints } from "../read-model/demand-curve-queries";
import {
  demandCurveStreamId,
  liquidityEstimatedEventType,
  writeDemandCurve,
  getDemandCurveCursor,
  saveDemandCurveCursor,
} from "../read-model/demand-curve-writes";
import { listDemandCurveCandidates } from "../read-model/demand-curve-candidates";
import { createDemandCurveCloser } from "../api/demand-curve-closer";
import { generateSyntheticProviderObservationFixture } from "../../price-signals/tests/fixtures/provider-observations/generate-fixture";
import { commitProviderObservationCapture } from "../../price-signals/read-model/provider-observation-writes";
import { listProviderListingAskGroups } from "../../price-signals/read-model/provider-observation-queries";
import { buildConditionLadder } from "../domain/condition-ladder/condition-ladder";
import { effectiveSaleAmountExact } from "../../price-signals/domain/effective-sale-price";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../domain/demand-curve-policy";
import { MARKET_ESTIMATE_LAUNCH_POLICY_VALUE } from "../domain/estimate-policy";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../price-signals/domain/provider-observation-policy";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = baseUrl ? describe : describe.skip;
const catalogItemId = "cat_demand_curve_synthetic";
const productId = `${catalogItemId}::near-mint-normal-english`;
const at = "2026-09-01T15:00:00.000Z";

function stubDemandCurvePolicies(): PolicyRuntime {
  return {
    resolvePolicy: async (definition: { policyKey: string }) => ({
      value:
        definition.policyKey === "pricing.demand-curve"
          ? DEMAND_CURVE_LAUNCH_POLICY_VALUE
          : definition.policyKey === "pricing.market-estimate"
            ? MARKET_ESTIMATE_LAUNCH_POLICY_VALUE
            : definition.policyKey === "pricing.market-stat-hygiene"
              ? MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE
              : PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
      documentId: null,
    }),
  } as unknown as PolicyRuntime;
}

describeDb("Demand Curve immutable versions and LiquidityEstimated", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["pricing"], "pricing_demand_curve");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  function version(fingerprint = "fingerprint-one", builtAt = at) {
    return {
      catalogItemId,
      productId,
      providerCondition: "Near Mint",
      providerVariant: "Normal",
      providerLanguage: "English",
      fingerprint,
      policyRevisionId: "synthetic-policy-r1",
      ladderMethod: "neutral-condition-fallback",
      anchorCondition: null,
      exposureStartReason: "history-window",
      salesCoverage: "complete",
      supplyStatus: "observed" as const,
      ownSellerExclusionApplied: false,
      builtAt,
      points: [5, 50, 95].map((percentile) => ({
        percentile,
        priceAmount: `${percentile}.00`,
        buyerArrivalIntervalDays: 2,
        competingSellerCount: 0,
        storeWinShare: 1,
        medianSellDays: 1.38629436,
        qualifyingSaleCount: 10,
        historyCapped: false,
        hopeless: false,
        supplyStatus: "observed" as const,
      })),
    };
  }

  it("publishes once per version, serves the newest version, and returns qualified ascending points", async () => {
    const store = createPostgresEventStore({ pool });
    expect(await writeDemandCurve(pool, store, version())).toBe("built");
    expect(await writeDemandCurve(pool, store, version("fingerprint-one", "2026-09-01T15:30:00.000Z"))).toBe(
      "unchanged",
    );
    expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: at })).toMatchObject({
      version: 1,
      supplyStatus: "observed",
    });
    const points = await listDemandCurvePoints(pool, { catalogItemId, productId, version: 1 });
    expect(points.map((point) => point.percentile)).toEqual([5, 50, 95]);
    expect(points.every((point) => point.salesCoverage === "complete")).toBe(true);
    expect(await writeDemandCurve(pool, store, version("fingerprint-two", "2026-09-02T15:00:00.000Z"))).toBe("built");
    const events = await store.readStream({ streamId: demandCurveStreamId({ catalogItemId, productId }) });
    expect(events.map((event) => event.eventType)).toEqual([liquidityEstimatedEventType, liquidityEstimatedEventType]);
    expect(events[1]?.payload).toMatchObject({
      curveVersion: 2,
      marketMedianSellDays: 1.38629436,
      competingSellerCount: 0,
    });
    expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: "2026-09-03T00:00:00.000Z" })).toMatchObject({
      version: 2,
    });
    expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: "2026-08-31T00:00:00.000Z" })).toBeNull();
  });

  it("two interleaved writers cannot commit a lost version or duplicate event", async () => {
    const store = createPostgresEventStore({ pool });
    let arrive = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interleaved = {
      ...store,
      readStreamInTransaction: async (...args: Parameters<typeof store.readStreamInTransaction>) => {
        const page = await store.readStreamInTransaction(...args);
        if (++arrive === 2) release();
        await bothRead;
        return page;
      },
    };
    const attempts = await Promise.allSettled([
      writeDemandCurve(pool, interleaved, version("first")),
      writeDemandCurve(pool, interleaved, version("second")),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled" && result.value === "built")).toHaveLength(1);
    expect(await store.readStream({ streamId: demandCurveStreamId({ catalogItemId, productId }) })).toHaveLength(1);
  });

  it("cursor writes require the generation and exact tuple the writer read", async () => {
    expect(await saveDemandCurveCursor(pool, null, { priority: 0, catalogItemId, productId }, at)).toBe(true);
    const read = await getDemandCurveCursor(pool);
    expect(read?.generation).toBe(1);
    expect(await saveDemandCurveCursor(pool, read, { priority: 1, catalogItemId, productId }, at)).toBe(true);
    expect(await saveDemandCurveCursor(pool, read, null, at)).toBe(false);
  });

  it("unbound and multiply-bound provider tuples persist nothing and are counted", async () => {
    await pool.query(
      `INSERT INTO pricing_external_market_captures
      (capture_id,provider_key,catalog_item_id,external_key,signal_pass_started_at,signal_policy_revision_id,
       products_per_pass,capture_started_at,capture_completed_at,authenticated_request,recorded_signal_count,
       unresolved_signal_count,outcome_kind,rejected_row_count)
      VALUES ('synthetic-capture','tcgplayer',$1,'product:synthetic',$2,'synthetic-revision',1,$2,$2,false,0,0,'recorded',0)`,
      [catalogItemId, at],
    );
    async function bucket(externalKey: string, condition: string, key: string | null) {
      await pool.query(
        `INSERT INTO pricing_external_weekly_sale_buckets
        (provider_key,external_key,catalog_item_id,catalog_product_key,week_start,provider_condition,provider_variant,
         provider_language,transaction_count,quantity_sold,last_capture_id,last_observed_at,updated_at)
        VALUES ('tcgplayer',$1,$2,$3,'2026-08-31',$4,'Normal','English',1,1,'synthetic-capture',$5,$5)`,
        [externalKey, catalogItemId, key, condition, at],
      );
    }
    await bucket("sku:1", "Near Mint", productId);
    await bucket("sku:2", "Lightly Played", null);
    await bucket("sku:3", "Damaged", productId);
    await bucket("sku:4", "Damaged", "product_conflict");
    const page = await listDemandCurveCandidates(pool, {
      since: "2026-08-01T00:00:00Z",
      asOf: at,
      limit: 10,
      after: null,
    });
    expect(page.candidates.map((candidate) => candidate.condition)).toEqual(["Near Mint"]);
    expect(page.unmapped).toBe(2);
    await pool.query(
      `INSERT INTO pricing_market_trades
      (order_id,line_id,seller_account_id,buyer_account_id,catalog_catalog_item_id,product_id,
       unit_price_amount,currency_code,quantity,sale_channel,sold_at,updated_at)
      SELECT 'order_' || n,'line_' || n,'seller_' || n,'buyer_' || n,$1,$2,10+n,'USD',1,
             'listing','2026-08-31T15:00:00Z','2026-08-31T15:00:00Z'
      FROM generate_series(1,3) AS n`,
      [catalogItemId, productId],
    );
    const result = await createDemandCurveCloser({
      pool,
      eventStore: createPostgresEventStore({ pool }),
      policies: stubDemandCurvePolicies(),
    }).runDemandCurveCloser({ now: at, limit: 10 });
    expect(result.built).toBe(1);
    expect(result.unmapped).toBe(2);
    expect((await pool.query(`SELECT product_id FROM pricing_demand_curve_versions`)).rows).toEqual([
      { product_id: productId },
    ]);
  });

  it("single-printing joint remains observed; Normal+Foil never pools a seller count", async () => {
    const { capture } = generateSyntheticProviderObservationFixture();
    const fixtureItem = capture.header.catalogItemId;
    const nearMintKey = `${fixtureItem}::near-mint-normal-english`;
    await commitProviderObservationCapture(
      pool,
      "tcgplayer",
      {
        productExternalKey: "product:700000001",
        productId: 700000001,
        catalogItemId: fixtureItem,
        skus: [],
        expectedCursor: { afterExternalKey: "", generation: 0 },
        nextCursor: { afterExternalKey: "", generation: 1 },
      },
      capture,
    );
    for (const [condition, index] of [
      ["Near Mint", 1],
      ["Lightly Played", 2],
    ] as const) {
      await pool.query(
        `INSERT INTO pricing_external_weekly_sale_buckets
        (provider_key,external_key,catalog_item_id,catalog_product_key,week_start,provider_condition,provider_variant,
         provider_language,transaction_count,quantity_sold,last_capture_id,last_observed_at,updated_at)
        VALUES ('tcgplayer',$1,$2,$3,'2026-08-31',$4,'Normal','English',1,1,$5,$6,$6)`,
        [
          `sku:${index}`,
          fixtureItem,
          index === 1 ? nearMintKey : `${fixtureItem}::lightly-played-normal-english`,
          condition,
          capture.header.captureId,
          capture.header.captureStartedAt,
        ],
      );
    }
    const closer = createDemandCurveCloser({
      pool,
      eventStore: createPostgresEventStore({ pool }),
      policies: stubDemandCurvePolicies(),
    });
    const first = await closer.runDemandCurveCloser({ now: capture.header.captureStartedAt, limit: 10 });
    expect(first.built).toBe(2);
    const served = await getDemandCurve(pool, {
      catalogItemId: fixtureItem,
      productId: nearMintKey,
      asOf: capture.header.captureStartedAt,
    });
    expect(served?.supplyStatus).toBe("observed");
    const points = await listDemandCurvePoints(pool, {
      catalogItemId: fixtureItem,
      productId: nearMintKey,
      version: 1,
    });
    const sales = capture.sales.map((sale) => ({
      condition: sale.providerCondition,
      price: effectiveSaleAmountExact(
        { quantity: sale.quantity, unitPrice: Number(sale.unitPrice), orderShipping: Number(sale.orderShipping) },
        Number(PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.freeShippingThreshold),
      ),
      soldAt: sale.soldAt,
    }));
    const ladder = buildConditionLadder({
      sales,
      siblingMarketPrices: new Map(),
      targetCondition: "Near Mint",
      asOf: capture.header.captureStartedAt,
      policy: DEMAND_CURVE_LAUNCH_POLICY_VALUE,
    });
    const joint = await listProviderListingAskGroups(pool, {
      providerKey: "tcgplayer",
      catalogItemId: fixtureItem,
      captureId: capture.header.captureId,
    });
    for (const point of points) {
      const scaledCount = new Set(
        joint
          .filter(
            (ask) =>
              Number(ask.deliveredAmount) * ladder.multipliers.get(ask.providerCondition)! <= Number(point.priceAmount),
          )
          .map((ask) => ask.anonymousCaptureSellerOrdinal),
      ).size;
      expect(point.competingSellerCount).toBe(scaledCount);
    }
    await pool.query(
      `INSERT INTO pricing_external_listing_snapshots
      (provider_key,catalog_item_id,provider_variant,provider_language,provider_condition,observed_on,
       distinct_seller_count,last_capture_id,last_observed_at,updated_at)
      VALUES ('tcgplayer',$1,'Foil','English','Near Mint','2026-09-01',1,$2,$3,$3)`,
      [fixtureItem, capture.header.captureId, capture.header.captureStartedAt],
    );
    const later = "2026-09-01T15:30:00.000Z";
    expect((await closer.runDemandCurveCloser({ now: later, limit: 10 })).supplyUnscoped).toBeGreaterThan(0);
    const unscoped = await getDemandCurve(pool, { catalogItemId: fixtureItem, productId: nearMintKey, asOf: later });
    expect(unscoped?.supplyStatus).toBe("unavailable");
    expect(
      (
        await listDemandCurvePoints(pool, {
          catalogItemId: fixtureItem,
          productId: nearMintKey,
          version: unscoped!.version,
        })
      ).every((point) => point.competingSellerCount === null),
    ).toBe(true);
  });
});
