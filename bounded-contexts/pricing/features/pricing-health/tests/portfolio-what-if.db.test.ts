import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPricingHealthWhatIfAdapter } from "../api/portfolio-what-if";
import { sweepDailyReturnHurdles } from "../../repricing-policies/domain/portfolio/preview";
import { resolvedGoalEconomics } from "../../repricing-policies/tests/fixtures/goal-economics";
import { portfolioScenario } from "../../repricing-policies/tests/fixtures/portfolio-parity";

const now = "2026-10-19T10:00:00.000Z";
const listings = Array.from({ length: 501 }, (_, index) => {
  const catalogItemId = index % 3 === 0 ? "cat-a" : index % 3 === 1 ? "cat-b" : "cat-none";
  return {
    listing_id: `lst-${String(index).padStart(4, "0")}`,
    inventory_item_id: null,
    catalog_catalog_item_id: catalogItemId,
    product_id: "prod-1",
    price_amount: "10.00",
    price_currency_code: "USD",
    quantity_cap: 1,
  };
});
const curve = {
  catalogItemId: "cat-a",
  productId: "prod-1",
  version: 1,
  providerCondition: "Near Mint",
  providerVariant: "Normal",
  providerLanguage: "English",
  fingerprint: "synthetic",
  modelVersion: "synthetic",
  policyRevisionId: "synthetic",
  ladderMethod: "synthetic",
  anchorCondition: null,
  exposureStartReason: "synthetic",
  salesCoverage: "synthetic",
  supplyStatus: "observed",
  ownSellerExclusionApplied: null,
  builtAt: now,
  built_at: now,
  currency_code: "USD",
  currencyCode: "USD",
  fresh_until: "2100-01-01T00:00:00.000Z",
  freshUntil: "2100-01-01T00:00:00.000Z",
  points: portfolioScenario("one-listing")[0]!.curve.points,
};

describe("Pricing Health portfolio what-if adapter", () => {
  it("assembles an over-page listing set before producing stable overall, Product Line and null-line snapshots", async () => {
    const db: PgQueryable = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("FROM pricing_market_listing_inputs")) {
          const after = values?.[1] as string | null;
          const start = after === null ? 0 : 500;
          return { rows: listings.slice(start, start + (after === null ? 500 : 1)) as Row[] };
        }
        if (sql.includes("FROM pricing_catalog_item_inputs")) {
          return {
            rows: [
              { catalog_item_id: "cat-a", product_line_reference_id: "line-a", product_line_name: "Line A", product_line_version: 1 },
              { catalog_item_id: "cat-b", product_line_reference_id: "line-b", product_line_name: "Line B", product_line_version: 1 },
              { catalog_item_id: "cat-none", product_line_reference_id: null, product_line_name: null, product_line_version: null },
            ] as Row[],
          };
        }
        if (sql.includes("SELECT DISTINCT ON")) {
          return {
            rows: ["cat-a", "cat-b", "cat-none"].map((catalog_item_id) => ({ ...curve, catalog_item_id, product_id: "prod-1" })) as Row[],
          };
        }
        if (sql.includes("pricing_demand_curve_points")) {
          return {
            rows: ["cat-a", "cat-b", "cat-none"].flatMap((catalog_item_id) =>
              portfolioScenario("one-listing")[0]!.curve.points.map((point) => ({
                catalog_item_id,
                product_id: "prod-1",
                percentile: point.percentile,
                price_amount: point.priceAmount,
                buyer_arrival_interval_days: point.buyerArrivalIntervalDays,
                competing_seller_count: point.competingSellerCount,
                store_win_share: point.storeWinShare,
                median_sell_days: point.medianSellDays,
                qualifying_sale_count: point.qualifyingSaleCount,
                history_capped: point.historyCapped,
                hopeless: point.hopeless,
                supply_status: point.supplyStatus,
              })),
            ) as Row[],
          };
        }
        throw new Error(`Unexpected read: ${sql.slice(0, 80)}`);
      },
    };
    const adapter = createPricingHealthWhatIfAdapter({
      db,
      economics: { resolve: async () => ({ kind: "unavailable", reason: "provider-unavailable", currency: "USD", accountId: "acc", channel: { kind: "native-marketplace" }, effectiveAt: now, revision: "synthetic", facts: { costBasisShareOfMarketBps: { sourceValue: 7000, effectiveValue: 7000, source: { kind: "policy-default", policyRevision: "synthetic", reason: "provider-unavailable" }, override: null, observedAt: now }, costBasisCoverageBps: { sourceValue: 0, effectiveValue: 0, source: { kind: "policy-default", policyRevision: "synthetic", reason: "provider-unavailable" }, override: null, observedAt: now }, costBasisDiscountPerUnitAmount: { sourceValue: { amount: "0.00", currency: "USD" }, effectiveValue: { amount: "0.00", currency: "USD" }, source: { kind: "policy-default", policyRevision: "synthetic", reason: "provider-unavailable" }, override: null, observedAt: now }, turnaroundDays: { sourceValue: 28, effectiveValue: 28, source: { kind: "policy-default", policyRevision: "synthetic", reason: "provider-unavailable" }, override: null, observedAt: now }, dailyReturnHurdle: { sourceValue: 0.01, effectiveValue: 0.01, source: { kind: "policy-default", policyRevision: "synthetic", reason: "provider-unavailable" }, override: null, observedAt: now } }, diagnostics: { observedHoldDays: null, capitalCycleDays: null, hurdleStatus: "defaulted", hurdleReason: "provider-unavailable", inventoryWatermark: "synthetic", pricingWatermark: "synthetic", generatedAt: now, inventoryObservedAt: now, pricingObservedAt: now, generatedAgeSeconds: 0, inventorySourceAgeSeconds: 0, pricingSourceAgeSeconds: 0 } }) },
    });
    const result = await adapter.get("acc", now);
    expect(result.portfolios.map((portfolio) => portfolio.label)).toEqual(["Overall portfolio", "Line A", "Line B", "No product line"]);
    expect(result.portfolios[0]!.listingCount).toBe(501);
    expect(result.portfolios.every((portfolio) => portfolio.snapshotHash !== null)).toBe(true);
  });

  it("makes distinct hurdle scenarios and selects only a positive best cycle", () => {
    const economics = resolvedGoalEconomics({ platformFeeRelativeBps: 1000, platformFeeFixedPerUnitAmount: "0.00", platformFeeCapPerUnitAmount: null, sellerHandlingRelativeBps: 0, sellerHandlingFixedPerUnitAmount: "0.00", sellerHandlingCapPerUnitAmount: null }, 0.01);
    const listing = { listingId: "one", currentPriceAmount: "10.00" as never, curve: portfolioScenario("one-listing")[0]!.curve, economics };
    const sweep = sweepDailyReturnHurdles({ currencyCode: "USD", listings: [listing], dailyReturnHurdles: [0.001, 0.05] });
    expect(sweep.scenarios[0]!.dailyReturnHurdle).not.toBe(sweep.scenarios[1]!.dailyReturnHurdle);
    expect(sweep.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
