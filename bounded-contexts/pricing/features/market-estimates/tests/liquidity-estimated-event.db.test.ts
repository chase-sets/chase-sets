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
import { readFileSync } from "node:fs";

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

  async function syntheticBinding(condition: string) {
    await pool.query(
      `INSERT INTO pricing_external_market_captures
       (capture_id,provider_key,catalog_item_id,external_key,signal_pass_started_at,signal_policy_revision_id,
        products_per_pass,capture_started_at,capture_completed_at,authenticated_request,recorded_signal_count,
        unresolved_signal_count,outcome_kind,rejected_row_count,currency,sales_coverage)
       VALUES ('synthetic-capture','tcgplayer',$1,'product:synthetic',$2,'synthetic-revision',1,$2,$2,
               false,0,0,'recorded',0,'usd','complete')`,
      [catalogItemId, at],
    );
    await pool.query(
      `INSERT INTO pricing_external_weekly_sale_buckets
       (provider_key,external_key,catalog_item_id,catalog_product_key,week_start,provider_condition,provider_variant,
        provider_language,transaction_count,quantity_sold,last_capture_id,last_observed_at,updated_at)
       VALUES ('tcgplayer','sku:synthetic',$1,$2,'2026-08-31',$3,'Normal','English',1,1,'synthetic-capture',$4,$4)`,
      [catalogItemId, productId, condition, at],
    );
  }

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

  it("skips an unknown bound condition and advances the cursor without persisting a curve", async () => {
    await syntheticBinding("Unopened");
    const result = await createDemandCurveCloser({
      pool,
      eventStore: createPostgresEventStore({ pool }),
      policies: stubDemandCurvePolicies(),
    }).runDemandCurveCloser({ now: at, limit: 1 });
    expect(result).toMatchObject({ built: 0, unknownCondition: 1 });
    expect((await pool.query(`SELECT version FROM pricing_demand_curve_versions`)).rows).toHaveLength(0);
    expect(await getDemandCurveCursor(pool)).toMatchObject({ catalogItemId, productId, generation: 1 });
  });

  it("supersedes a served condition omitted by a revised policy and completes the pass", async () => {
    await syntheticBinding("Damaged");
    const store = createPostgresEventStore({ pool });
    await writeDemandCurve(pool, store, {
      ...version("synthetic-served", "2026-09-01T14:00:00.000Z"),
      providerCondition: "Damaged",
    });
    const revised = {
      resolvePolicy: async (definition: { policyKey: string }) => {
        const resolved = await stubDemandCurvePolicies().resolvePolicy(definition as never);
        return definition.policyKey === "pricing.demand-curve"
          ? {
              ...resolved,
              value: {
                ...DEMAND_CURVE_LAUNCH_POLICY_VALUE,
                conditionOrder: DEMAND_CURVE_LAUNCH_POLICY_VALUE.conditionOrder.filter(
                  (condition) => condition !== "Damaged",
                ),
              },
            }
          : resolved;
      },
    } as unknown as PolicyRuntime;
    const result = await createDemandCurveCloser({ pool, eventStore: store, policies: revised }).runDemandCurveCloser({
      now: at,
      limit: 1,
    });
    expect(result).toMatchObject({ built: 0, superseded: 1, unknownCondition: 1 });
    expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: at })).toBeNull();
    expect(await getDemandCurveCursor(pool)).toMatchObject({ catalogItemId, productId, generation: 1 });
  });

  it("serves the latest capped provider sales with sales-cap exposure", async () => {
    await syntheticBinding("Near Mint");
    await pool.query(
      `INSERT INTO pricing_external_sale_observations
       (capture_id,sale_fingerprint,observed_occurrence_count,provider_condition,provider_variant,
        provider_language,listing_type,sold_at,quantity,unit_price,order_shipping)
       SELECT 'synthetic-capture','synthetic-sale-' || n,1,'Near Mint','Normal','English',
              'ListingWithPhotos',$1::timestamptz - n * interval '1 hour',1,
              CASE WHEN n = $2 THEN 1000 ELSE 10 END,0
       FROM generate_series(1,$2) AS n`,
      [at, DEMAND_CURVE_LAUNCH_POLICY_VALUE.salesLimit + 1],
    );
    const result = await createDemandCurveCloser({
      pool,
      eventStore: createPostgresEventStore({ pool }),
      policies: stubDemandCurvePolicies(),
    }).runDemandCurveCloser({ now: at });
    expect(result.built).toBe(1);
    const served = await getDemandCurve(pool, { catalogItemId, productId, asOf: at });
    expect(served?.exposureStartReason).toBe("sales-cap");
    const points = await listDemandCurvePoints(pool, { catalogItemId, productId, version: served!.version });
    expect(points.every((point) => point.historyCapped && Number(point.priceAmount) < 100)).toBe(true);
  });

  it("dedupes platform pairs before retaining the latest capped trades", async () => {
    await syntheticBinding("Near Mint");
    await pool.query(
      `INSERT INTO pricing_market_trades
       (order_id,line_id,seller_account_id,buyer_account_id,catalog_catalog_item_id,product_id,
        unit_price_amount,currency_code,quantity,sale_channel,sold_at,updated_at)
       SELECT 'synthetic-order-' || n,'synthetic-line-' || n,'synthetic-seller-' || n,
              'synthetic-buyer-' || n,$1,$2,CASE WHEN n = $3 THEN 1000 ELSE 10 END,'USD',1,
              'listing',$4::timestamptz - n * interval '1 hour',$4::timestamptz - n * interval '1 hour'
       FROM generate_series(1,$3) AS n`,
      [catalogItemId, productId, DEMAND_CURVE_LAUNCH_POLICY_VALUE.salesLimit + 1, at],
    );
    await pool.query(
      `INSERT INTO pricing_market_trades
       (order_id,line_id,seller_account_id,buyer_account_id,catalog_catalog_item_id,product_id,
        unit_price_amount,currency_code,quantity,sale_channel,sold_at,updated_at)
       VALUES ('synthetic-duplicate','synthetic-duplicate','synthetic-seller-1','synthetic-buyer-1',
               $1,$2,1000,'USD',1,'listing',$3::timestamptz - interval '6 days',
               $3::timestamptz - interval '6 days')`,
      [catalogItemId, productId, at],
    );
    const result = await createDemandCurveCloser({
      pool,
      eventStore: createPostgresEventStore({ pool }),
      policies: stubDemandCurvePolicies(),
    }).runDemandCurveCloser({ now: at });
    expect(result.built).toBe(1);
    const served = await getDemandCurve(pool, { catalogItemId, productId, asOf: at });
    expect(served?.exposureStartReason).toBe("sales-cap");
    const points = await listDemandCurvePoints(pool, { catalogItemId, productId, version: served!.version });
    expect(points.every((point) => point.historyCapped && Number(point.priceAmount) < 100)).toBe(true);
  });

  it.each([
    ["provider", 101],
    ["provider", 150],
    ["platform", 101],
    ["platform", 150],
  ] as const)("persists capped exposure after trimming %s price-spread overflow %i", async (source, count) => {
    await syntheticBinding("Near Mint");
    await pool.query(
      `UPDATE pricing_external_market_captures
       SET listings_status='observed',listings_coverage='complete'
       WHERE capture_id='synthetic-capture'`,
    );
    if (source === "provider") {
      await pool.query(
        `INSERT INTO pricing_external_sale_observations
         (capture_id,sale_fingerprint,observed_occurrence_count,provider_condition,provider_variant,
          provider_language,listing_type,sold_at,quantity,unit_price,order_shipping)
         SELECT 'synthetic-capture','synthetic-spread-' || n,1,'Near Mint','Normal','English',
                'ListingWithPhotos',$1::timestamptz - n * interval '1 hour',1,5 + n * 0.10,0
         FROM generate_series(1,$2) AS n`,
        [at, count],
      );
    } else {
      await pool.query(
        `INSERT INTO pricing_market_trades
         (order_id,line_id,seller_account_id,buyer_account_id,catalog_catalog_item_id,product_id,
          unit_price_amount,currency_code,quantity,sale_channel,sold_at,updated_at)
         SELECT 'synthetic-spread-order-' || n,'synthetic-spread-line-' || n,'synthetic-spread-seller-' || n,
                'synthetic-spread-buyer-' || n,$1,$2,5 + n * 0.10,'USD',1,
                'listing',$3::timestamptz - n * interval '1 hour',$3::timestamptz - n * interval '1 hour'
         FROM generate_series(1,$4) AS n`,
        [catalogItemId, productId, at, count],
      );
    }
    const store = createPostgresEventStore({ pool });
    const closer = createDemandCurveCloser({ pool, eventStore: store, policies: stubDemandCurvePolicies() });
    const readEvents = () => store.readStream({ streamId: demandCurveStreamId({ catalogItemId, productId }) });
    expect(await closer.runDemandCurveCloser({ now: at })).toMatchObject({ built: 1, unchanged: 0 });
    const served = await getDemandCurve(pool, { catalogItemId, productId, asOf: at });
    expect(served).toMatchObject({ exposureStartReason: "sales-cap", supplyStatus: "observed", version: 1 });
    const points = await listDemandCurvePoints(pool, { catalogItemId, productId, version: served!.version });
    function assertCappedPoints(actual: typeof points) {
      expect(actual).toHaveLength(19);
      for (const point of actual) {
        expect(point.historyCapped).toBe(true);
        expect(Number(point.priceAmount)).toBeGreaterThanOrEqual(5.6);
        expect(Number(point.priceAmount)).toBeLessThanOrEqual(14.5);
        expect(point.buyerArrivalIntervalDays).not.toBeNull();
        expect(Number.isFinite(point.buyerArrivalIntervalDays)).toBe(true);
        expect(point.buyerArrivalIntervalDays).toBeGreaterThan(0);
        expect(point.medianSellDays).not.toBeNull();
        expect(Number.isFinite(point.medianSellDays)).toBe(true);
        expect(point.medianSellDays).toBeGreaterThan(0);
      }
    }
    assertCappedPoints(points);
    const initialEvents = await readEvents();
    expect(initialEvents.map((event) => event.eventType)).toEqual([liquidityEstimatedEventType]);
    expect(initialEvents[0]?.payload).toMatchObject({ curveVersion: 1 });
    if (source === "provider") {
      await pool.query(
        `INSERT INTO pricing_external_sale_observations
         (capture_id,sale_fingerprint,observed_occurrence_count,provider_condition,provider_variant,
          provider_language,listing_type,sold_at,quantity,unit_price,order_shipping)
         VALUES ('synthetic-capture','synthetic-unusable-condition',20,'Unopened','Normal','English',
                 'ListingWithPhotos',$1,1,10,0),
                ('synthetic-capture','synthetic-unusable-price',20,'Near Mint','Normal','English',
                 'ListingWithPhotos',$1,1,0,0)`,
        [at],
      );
      expect(await closer.runDemandCurveCloser({ now: at })).toMatchObject({ built: 0, unchanged: 1 });
      expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: at })).toEqual(served);
      expect(await listDemandCurvePoints(pool, { catalogItemId, productId, version: 1 })).toEqual(points);
      expect(await readEvents()).toEqual(initialEvents);
      if (count === 150) {
        await pool.query(
          `DELETE FROM pricing_external_sale_observations
           WHERE capture_id='synthetic-capture' AND sold_at < $1::timestamptz - interval '101 hours'`,
          [at],
        );
        expect(await closer.runDemandCurveCloser({ now: at })).toMatchObject({ built: 0, unchanged: 1 });
        expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: at })).toEqual(served);
        expect(await listDemandCurvePoints(pool, { catalogItemId, productId, version: 1 })).toEqual(points);
        expect(await readEvents()).toEqual(initialEvents);
      }
    }
    // At exactly 100, only the provider switches from recency to fingerprint order.
    if (source === "provider")
      await pool.query(
        `DELETE FROM pricing_external_sale_observations
         WHERE capture_id='synthetic-capture' AND sold_at < $1::timestamptz - interval '100 hours'`,
        [at],
      );
    else
      await pool.query(
        `DELETE FROM pricing_market_trades
         WHERE catalog_catalog_item_id=$1 AND sold_at < $2::timestamptz - interval '100 hours'`,
        [catalogItemId, at],
      );
    expect(await closer.runDemandCurveCloser({ now: at })).toMatchObject(
      source === "provider" ? { built: 1, unchanged: 0 } : { built: 0, unchanged: 1 },
    );
    const exactCap = await getDemandCurve(pool, { catalogItemId, productId, asOf: at });
    const exactCapPoints = await listDemandCurvePoints(pool, { catalogItemId, productId, version: exactCap!.version });
    const exactCapEvents = await readEvents();
    if (source === "provider") {
      expect(exactCap).toMatchObject({ version: 2, exposureStartReason: "sales-cap", supplyStatus: "observed" });
      expect(exactCap!.fingerprint).not.toBe(served!.fingerprint);
      assertCappedPoints(exactCapPoints);
      expect(exactCapEvents.map((event) => event.eventType)).toEqual([
        liquidityEstimatedEventType,
        liquidityEstimatedEventType,
      ]);
      expect(exactCapEvents[0]).toEqual(initialEvents[0]);
      expect(exactCapEvents[1]?.payload).toMatchObject({ curveVersion: 2 });
    } else {
      expect(exactCap).toEqual(served);
      expect(exactCapPoints).toEqual(points);
      expect(exactCapEvents).toEqual(initialEvents);
    }
    expect(await listDemandCurvePoints(pool, { catalogItemId, productId, version: 1 })).toEqual(points);
    expect(await closer.runDemandCurveCloser({ now: at })).toMatchObject({ built: 0, unchanged: 1 });
    expect(await getDemandCurve(pool, { catalogItemId, productId, asOf: at })).toEqual(exactCap);
    expect(await listDemandCurvePoints(pool, { catalogItemId, productId, version: exactCap!.version })).toEqual(
      exactCapPoints,
    );
    expect(await listDemandCurvePoints(pool, { catalogItemId, productId, version: 1 })).toEqual(points);
    expect(await readEvents()).toEqual(exactCapEvents);
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
    const oracle = JSON.parse(
      readFileSync(new URL("./fixtures/app-recorded-ninety-day-oracle.json", import.meta.url), "utf8"),
    ) as {
      points: readonly { price: number; buyerIntervalDays: number; medianSellDays: number; sellers: number }[];
    };
    for (const [index, point] of points.entries()) {
      const expected = oracle.points[index]!;
      expect(Math.abs(Number(point.priceAmount) - expected.price)).toBeLessThanOrEqual(0.01);
      expect(
        Math.abs(point.buyerArrivalIntervalDays! - expected.buyerIntervalDays) / expected.buyerIntervalDays,
      ).toBeLessThanOrEqual(0.01);
      expect(Math.abs(point.medianSellDays! - expected.medianSellDays) / expected.medianSellDays).toBeLessThanOrEqual(
        0.01,
      );
      expect(point.competingSellerCount).toBe(expected.sellers);
    }
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
