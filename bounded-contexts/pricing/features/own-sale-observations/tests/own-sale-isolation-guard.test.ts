import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { calculateBlendedMarketValueEstimate } from "../../market-estimates/domain/blended-estimate";
import { loadComparableSales } from "../../market-estimates/read-model/queries";
import { buildPricingMarketTradesProjectionHandlers } from "../../market-trades/integrations/source/source-projection";
import { buildPricingInventoryInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { buildPricingOwnSaleObservationProjectionHandlers } from "../integrations/inventory/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const PRICING_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FORBIDDEN_OWN_SALE_REFERENCE = /pricing_own_sale_observations|listOwnSaleObservations|getOwnSaleLows/;

describe("own-sale published-estimate source guard", () => {
  it("keeps both frozen queries on Pricing's public server boundary", () => {
    const serverSource = readFileSync(join(PRICING_ROOT, "server.ts"), "utf8");
    expect(serverSource).toContain("export { getOwnSaleLows, listOwnSaleObservations }");
    expect(serverSource).not.toMatch(/\bgetOwnSaleLow\b/);
  });

  it("keeps market estimates and market rollups independent from seller-scoped own-sale evidence", () => {
    const violations = ["market-estimates", "market-rollups"].flatMap((feature) =>
      sourceFiles(join(PRICING_ROOT, "features", feature)).flatMap((file) =>
        FORBIDDEN_OWN_SALE_REFERENCE.test(readFileSync(file, "utf8"))
          ? [relative(PRICING_ROOT, file).replaceAll("\\", "/")]
          : [],
      ),
    );
    expect(violations).toEqual([]);
  });
});

describeDb("own-sale published-estimate input isolation", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_own_sale_isolation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });

  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("passes the identical comparable set to calculateBlendedMarketValueEstimate when own-sale rows exist", async () => {
    const catalogItemId = "cat_synthetic_isolation";
    const productId = "prod_synthetic_isolation";
    const trades = buildPricingMarketTradesProjectionHandlers(pool);

    for (const [ordinal, amount] of ["10.00", "12.00", "14.00"].entries()) {
      const orderId = `ord_synthetic_${ordinal + 1}`;
      await trades["ordering.order.created"]!(
        event({
          id: `evt_order_${ordinal + 1}`,
          type: "ordering.order.created",
          streamId: `ordering.order-${orderId}`,
          streamVersion: 1,
          data: {
            orderId,
            sourceType: "cart-checkout",
            buyerAccountId: `acc_synthetic_buyer_${ordinal + 1}`,
            sellerAccountId: "acc_synthetic_market_seller",
            lines: [
              {
                lineId: "line_synthetic",
                catalogItemId,
                productId,
                unitPriceAmount: amount,
                quantity: 1,
              },
            ],
          },
          recordedAt: `2026-09-0${ordinal + 1}T00:00:00.000Z`,
        }),
      );
      await trades["ordering.order.ready-for-fulfillment-recorded"]!(
        event({
          id: `evt_ready_${ordinal + 1}`,
          type: "ordering.order.ready-for-fulfillment-recorded",
          streamId: `ordering.order-${orderId}`,
          streamVersion: 2,
          data: { orderId, readyForFulfillmentAt: `2026-09-0${ordinal + 1}T01:00:00.000Z` },
          recordedAt: `2026-09-0${ordinal + 1}T01:00:00.000Z`,
        }),
      );
    }

    const window = { since: "2026-09-01T00:00:00.000Z", now: "2026-09-10T00:00:00.000Z" };
    const before = await loadComparableSales(pool, { catalogItemId, productId }, window);

    const inventory = buildPricingInventoryInputProjectionHandlers(pool);
    await inventory["inventory.item.created"]!(
      event({
        id: "evt_own_item",
        type: "inventory.item.created",
        streamId: "inventory.item-inv_synthetic_isolation",
        streamVersion: 1,
        data: {
          itemId: "inv_synthetic_isolation",
          accountId: "acc_synthetic_own_seller",
          catalogItemId,
          productId,
          totalQuantity: 1,
        },
        recordedAt: "2026-09-08T00:00:00.000Z",
      }),
    );
    const ownSales = buildPricingOwnSaleObservationProjectionHandlers(pool);
    await ownSales["inventory.external-channel-sale.recorded"]!(
      event({
        id: "evt_own_sale",
        type: "inventory.external-channel-sale.recorded",
        streamId: "inventory.external-sale-synthetic-isolation",
        streamVersion: 1,
        accountId: "acc_synthetic_own_seller",
        data: {
          eventVersion: 1,
          saleKey: {
            version: "v1",
            providerKey: "synthetic-isolation",
            sellerEnvironmentLineage: "synthetic-environment",
            orderLineIdentity: "synthetic-line",
          },
          commandFingerprint: "synthetic-fingerprint",
          accountId: "acc_synthetic_own_seller",
          inventoryItemId: "inv_synthetic_isolation",
          storageLocationId: "loc_synthetic",
          requestedQuantity: 1,
          unitPriceAmount: "0.01",
          currencyCode: "USD",
          collisionMode: "protect-orders",
          collisionPolicyRef: "synthetic-policy",
          collisionPolicyRevision: 1,
          reasonCode: "sold-external-channel",
          result: { appliedQuantity: 1 },
        },
        recordedAt: "2026-09-08T00:01:00.000Z",
      }),
    );

    const after = await loadComparableSales(pool, { catalogItemId, productId }, window);
    expect((await pool.query(`SELECT COUNT(*)::integer AS count FROM pricing_own_sale_observations`)).rows).toEqual([
      { count: 1 },
    ]);
    expect(after).toEqual(before);

    const calculate = (comparableSales: typeof before) =>
      calculateBlendedMarketValueEstimate(comparableSales, {
        now: window.now,
        decayHalfLifeDays: 30,
        sourceWeights: { platformVerifiedTrade: 1, platformTrade: 1, externalComp: 1 },
        estimatePercentile: 50,
        bandLowPercentile: 25,
        bandHighPercentile: 75,
        minimumComparableSales: 3,
        minimumEffectiveSampleSize: 1,
        outlierPriceRatio: 3,
        maximumParticipantWeightShare: 0.3,
        confidenceSampleSizes: { medium: 3, high: 5 },
      });
    expect(calculate(after)).toEqual(calculate(before));
  });
});

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mjs)$/.test(entry) ? [path] : [];
  });
}

function event(
  input: Readonly<{
    id: string;
    type: string;
    streamId: string;
    streamVersion: number;
    data: Record<string, unknown>;
    recordedAt: string;
    accountId?: string;
  }>,
) {
  return {
    id: input.id,
    type: input.type,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    globalPosition: "1",
    tenantId: "tnt_synthetic_isolation",
    data: input.data,
    metadata: {},
    audit: {
      performedByUserId: "usr_synthetic_isolation",
      forAccountId: input.accountId ?? "acc_synthetic_market_seller",
    },
    trace: {},
    timing: { occurredAt: input.recordedAt, recordedAt: input.recordedAt },
  } as never;
}
