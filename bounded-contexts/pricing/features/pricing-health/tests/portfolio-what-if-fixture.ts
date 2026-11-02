import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeMoneyAmount, normalizeSignedMoneyAmount } from "@chase-sets/primitives/money";
import type { EconomicsFact } from "../../economics/domain/contracts";
import { toEconomicsForPricingGoal } from "../../economics/domain/resolution";
import { portfolioScenario } from "../../repricing-policies/tests/fixtures/portfolio-parity";

export const whatIfNow = "2026-10-19T10:00:00.000Z";
const fact = <T>(value: T): EconomicsFact<T> => ({
  sourceValue: value,
  effectiveValue: value,
  source: { kind: "policy-owned", policyRevision: "synthetic-what-if" },
  override: null,
  observedAt: whatIfNow,
});

export function whatIfEconomics(feeBps = 1000, hurdle = 0.0035, costBps = 7000) {
  const money = { amount: normalizeMoneyAmount("0.00"), currency: "usd" };
  return {
    kind: "resolved" as const,
    economics: {
      accountId: "acc",
      channel: { kind: "native-marketplace" as const },
      currency: "usd",
      effectiveAt: whatIfNow,
      revision: "synthetic-what-if",
      facts: {
        platformFeeRelativeBps: fact(feeBps),
        platformFeeFixedPerUnitAmount: fact(money),
        platformFeeCapPerUnitAmount: fact(null),
        sellerHandlingRelativeBps: fact(0),
        sellerHandlingFixedPerUnitAmount: fact(money),
        sellerHandlingCapPerUnitAmount: fact(null),
        shippingAllowanceBps: fact(0),
        costBasisShareOfMarketBps: fact(costBps),
        costBasisCoverageBps: fact(10000),
        costBasisDiscountPerUnitAmount: fact({ ...money, amount: normalizeSignedMoneyAmount("0.00") }),
        turnaroundDays: fact(28),
        dailyReturnHurdle: fact(hurdle),
      },
      diagnostics: {
        observedHoldDays: null,
        capitalCycleDays: null,
        hurdleStatus: "defaulted" as const,
        hurdleReason: null,
        inventoryWatermark: "synthetic",
        pricingWatermark: "synthetic",
        generatedAt: whatIfNow,
        inventoryObservedAt: whatIfNow,
        pricingObservedAt: whatIfNow,
        generatedAgeSeconds: 0,
        inventorySourceAgeSeconds: 0,
        pricingSourceAgeSeconds: 0,
      },
    },
  };
}

export function whatIfListing(index: number, currency: string | null = "USD", resolved = true) {
  return {
    listing_id: `lst-${String(index).padStart(4, "0")}`,
    inventory_item_id: resolved ? `inv-${index}` : null,
    catalog_catalog_item_id: index % 3 === 0 ? "cat-a" : index % 3 === 1 ? "cat-b" : "cat-none",
    product_id: "prod-1",
    price_amount: "10.00",
    price_currency_code: currency,
    quantity_cap: 1,
  };
}
export const whatIfPoints = portfolioScenario("one-listing")[0]!.curve.points;
export const whatIfLines = [
  {
    catalog_item_id: "cat-a",
    product_line_reference_id: "line-a",
    product_line_name: "Same name",
    product_line_version: 1,
  },
  {
    catalog_item_id: "cat-b",
    product_line_reference_id: "line-b",
    product_line_name: "Same name",
    product_line_version: 1,
  },
  {
    catalog_item_id: "cat-none",
    product_line_reference_id: null,
    product_line_name: null,
    product_line_version: null,
  },
];

export function assembledWhatIfListings(
  rows: readonly ReturnType<typeof whatIfListing>[],
  resolution = whatIfEconomics(),
) {
  return rows.map((row) => ({
    listingId: row.listing_id,
    currentPriceAmount: normalizeMoneyAmount(row.price_amount),
    curve: { currencyCode: "USD", version: 1, points: whatIfPoints },
    economics: row.inventory_item_id ? toEconomicsForPricingGoal(resolution) : null,
  }));
}

export function whatIfDb(rows: readonly ReturnType<typeof whatIfListing>[], curveCurrency: string | null = "USD") {
  const pages: unknown[][] = [];
  const db: PgQueryable = {
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM pricing_market_listing_inputs")) {
        pages.push([...(values ?? [])]);
        const after = values?.[1] as string | null;
        return {
          rows: rows.filter((row) => after === null || row.listing_id > after).slice(0, Number(values?.[2])) as Row[],
        };
      }
      if (sql.includes("FROM pricing_catalog_item_inputs")) return { rows: whatIfLines as Row[] };
      if (sql.includes("SELECT DISTINCT ON"))
        return {
          rows: whatIfLines.map(({ catalog_item_id }) => ({
            catalog_item_id,
            product_id: "prod-1",
            version: 1,
            currency_code: curveCurrency,
            built_at: whatIfNow,
            fresh_until: "2100-01-01T00:00:00.000Z",
          })) as Row[],
        };
      if (sql.includes("pricing_demand_curve_points"))
        return {
          rows: whatIfLines.flatMap(({ catalog_item_id }) =>
            whatIfPoints.map((point) => ({
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
      throw new Error(`Unexpected read: ${sql.slice(0, 80)}`);
    },
  };
  return { db, pages };
}
