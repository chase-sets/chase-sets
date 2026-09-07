import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { resolveMarketStatHygienePolicyRevisionAsOf } from "../../market-rollups/read-model/stat-hygiene-policy-revision";
import { module as pricingModule } from "../../../index";
import { createTcgplayerMarketCapture } from "../api/market-capture";
import {
  PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
  resolveProviderObservationPolicyRevisionAsOf,
} from "../domain/provider-observation-policy";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("provider-observation policy binding", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_policy_binding");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
    await seedInputs(pool);
    await seedPolicyHistory(pool);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("freezes the as-of revisions once and preserves them on every persisted evidence path", async () => {
    const run = createTcgplayerMarketCapture({
      pool,
      transport: syntheticTransport(),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      recordTcgplayerPriceSignal: async () => ({
        status: "unresolved",
        reason: "sku-reference-not-mapped",
        externalKey: "sku:990000001",
      }),
    });

    await expect(run()).resolves.toMatchObject({ status: "completed", capturesCommitted: 1 });
    const header = await pool.query<{
      capture_id: string;
      signal_policy_revision_id: string;
      observation_policy_revision_id: string;
      stat_hygiene_policy_revision_id: string;
      capture_started_at: string;
    }>(
      `SELECT capture_id, signal_policy_revision_id, observation_policy_revision_id,
              stat_hygiene_policy_revision_id, capture_started_at::text
       FROM pricing_external_market_captures`,
    );
    expect(header.rows).toEqual([
      expect.objectContaining({
        signal_policy_revision_id: "synthetic-signal-before-capture",
        observation_policy_revision_id: "synthetic-observation-before-capture",
        stat_hygiene_policy_revision_id: "synthetic-stat-before-capture",
      }),
    ]);

    const captureId = header.rows[0]!.capture_id;
    const bound = await pool.query<{
      evidence_kind: string;
      observation_revision: string;
      stat_revision: string;
    }>(
      `SELECT 'sale' AS evidence_kind, c.observation_policy_revision_id AS observation_revision,
              c.stat_hygiene_policy_revision_id AS stat_revision
       FROM pricing_external_sale_observations evidence
       JOIN pricing_external_market_captures c ON c.capture_id = evidence.capture_id
       WHERE c.capture_id = $1
       UNION ALL
       SELECT 'weekly', c.observation_policy_revision_id, c.stat_hygiene_policy_revision_id
       FROM pricing_external_weekly_sale_buckets evidence
       JOIN pricing_external_market_captures c ON c.capture_id = evidence.last_capture_id
       WHERE c.capture_id = $1
       UNION ALL
       SELECT 'snapshot', c.observation_policy_revision_id, c.stat_hygiene_policy_revision_id
       FROM pricing_external_listing_snapshots evidence
       JOIN pricing_external_market_captures c ON c.capture_id = evidence.last_capture_id
       WHERE c.capture_id = $1
       UNION ALL
       SELECT 'depth', c.observation_policy_revision_id, c.stat_hygiene_policy_revision_id
       FROM pricing_external_listing_ask_depth evidence
       JOIN pricing_external_market_captures c ON c.capture_id = evidence.capture_id
       WHERE c.capture_id = $1
       ORDER BY evidence_kind`,
      [captureId],
    );
    expect(bound.rows.map((row) => row.evidence_kind)).toEqual(["depth", "sale", "snapshot", "weekly"]);
    expect(bound.rows).toEqual(
      bound.rows.map((row) => ({
        evidence_kind: row.evidence_kind,
        observation_revision: "synthetic-observation-before-capture",
        stat_revision: "synthetic-stat-before-capture",
      })),
    );

    await expect(resolveProviderObservationPolicyRevisionAsOf(pool, "2026-09-02T00:05:00.000Z")).resolves.toMatchObject(
      { revisionId: "synthetic-observation-after-capture" },
    );
    await expect(resolveMarketStatHygienePolicyRevisionAsOf(pool, "2026-09-02T00:05:00.000Z")).resolves.toMatchObject({
      revisionId: "synthetic-stat-after-capture",
    });
    const afterMidnight = await pool.query<{
      observation_policy_revision_id: string;
      stat_hygiene_policy_revision_id: string;
    }>(
      `SELECT observation_policy_revision_id, stat_hygiene_policy_revision_id
       FROM pricing_external_market_captures
       WHERE capture_id = $1 AND capture_started_at < '2026-09-02T00:00:00.000Z'`,
      [captureId],
    );
    expect(afterMidnight.rows).toEqual([
      {
        observation_policy_revision_id: "synthetic-observation-before-capture",
        stat_hygiene_policy_revision_id: "synthetic-stat-before-capture",
      },
    ]);
  });
});

async function seedInputs(pool: PgTransactionalPool) {
  await pool.query(
    `INSERT INTO pricing_external_catalog_item_reference_inputs
       (provider_key, external_key, catalog_item_id, updated_at)
     VALUES ('tcgplayer','product:990000001','cat_unmistakably_synthetic','2026-09-01T14:00:00.000Z')`,
  );
  await pool.query(
    `INSERT INTO pricing_external_product_reference_inputs
       (provider_key, external_key, catalog_item_id, catalog_product_key, selected_options, updated_at)
     VALUES ('tcgplayer','sku:990000001','cat_unmistakably_synthetic','cat_unmistakably_synthetic::','[]','2026-09-01T14:00:00.000Z')`,
  );
}

async function seedPolicyHistory(pool: PgTransactionalPool) {
  const rows = [
    ["synthetic-signal-before-capture", "pricing.price-signal", { productsPerPass: 1 }, "2026-09-01T14:00:00.000Z"],
    [
      "synthetic-observation-before-capture",
      "pricing.provider-observation",
      { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
      "2026-09-01T14:00:00.000Z",
    ],
    [
      "synthetic-observation-after-capture",
      "pricing.provider-observation",
      { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 2 },
      "2026-09-01T16:00:00.000Z",
    ],
    [
      "synthetic-stat-before-capture",
      "pricing.market-stat-hygiene",
      MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE,
      "2026-09-01T14:00:00.000Z",
    ],
    [
      "synthetic-stat-after-capture",
      "pricing.market-stat-hygiene",
      { ...MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE, minimumTradeSample: 4 },
      "2026-09-01T16:00:00.000Z",
    ],
  ] as const;
  for (const [eventId, policyKey, value, recordedAt] of rows) {
    await pool.query(
      `INSERT INTO platform_policy_document_history
         (event_id, document_id, policy_key, event_type, actor_user_id, status, value,
          effective_from, effective_until, recorded_at)
       VALUES ($1, $1, $2, 'PolicyDocumentPublished', 'usr_unmistakably_synthetic', 'active', $3::jsonb,
               '2026-09-01T00:00:00.000Z', NULL, $4)`,
      [eventId, policyKey, JSON.stringify(value), recordedAt],
    );
  }
}

function syntheticTransport(): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>() =>
        [
          {
            skuId: 990000001,
            marketPrice: 10,
            lowestPrice: 9,
            highestPrice: 11,
            priceCount: 3,
            calculatedAt: "2026-09-01T14:00:00.000Z",
          },
        ] as T,
    },
    mpApi: {
      post: async <T>() =>
        ({
          previousPage: "",
          nextPage: "",
          resultCount: 1,
          totalResults: 1,
          data: [
            {
              condition: "Near Mint",
              variant: "Normal",
              language: "English",
              quantity: 1,
              title: "unmistakably synthetic",
              listingType: "All",
              customListingId: "synthetic-transient",
              purchasePrice: 5,
              shippingPrice: 0,
              orderDate: "2026-09-01T14:00:00.000Z",
            },
          ],
        }) as T,
    },
    mpSearchApi: {
      post: async <T>() =>
        ({
          errors: [],
          results: [
            {
              totalResults: 1,
              resultId: "synthetic-result",
              aggregations: {},
              results: [
                {
                  directProduct: false,
                  goldSeller: false,
                  listingId: 1,
                  channelId: 0,
                  conditionId: 1,
                  verifiedSeller: true,
                  directInventory: 0,
                  rankedShippingPrice: 0,
                  productId: 990000001,
                  printing: "Normal",
                  languageAbbreviation: "EN",
                  sellerName: "synthetic-transient-seller",
                  forwardFreight: false,
                  sellerShippingPrice: 0,
                  language: "English",
                  shippingPrice: 0,
                  condition: "Near Mint",
                  languageId: 1,
                  score: 0,
                  directSeller: false,
                  productConditionId: 1,
                  sellerId: "synthetic-transient-seller",
                  listingType: "standard",
                  sellerRating: 100,
                  sellerSales: "1",
                  quantity: 1,
                  sellerKey: "synthetic-transient-seller",
                  price: 10,
                  customData: { images: [] },
                },
              ],
            },
          ],
        }) as T,
    },
    infiniteApi: {
      get: async <T>() =>
        ({
          count: 1,
          result: [
            {
              skuId: "990000001",
              variant: "Normal",
              language: "English",
              condition: "Near Mint",
              averageDailyQuantitySold: "1",
              averageDailyTransactionCount: "1",
              totalQuantitySold: "1",
              totalTransactionCount: "1",
              trendingMarketPricePercentages: {},
              buckets: [
                {
                  marketPrice: "5.00",
                  quantitySold: "1",
                  lowSalePrice: "5.00",
                  lowSalePriceWithShipping: "5.00",
                  highSalePrice: "5.00",
                  highSalePriceWithShipping: "5.00",
                  transactionCount: "1",
                  bucketStartDate: "2026-09-01T00:00:00.000Z",
                },
              ],
            },
          ],
        }) as T,
    },
  };
}

function clock() {
  let instant = Date.parse("2026-09-01T14:59:58.000Z");
  return () => new Date((instant += 1_000)).toISOString();
}
