import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createDemandCurveCloser } from "../api/demand-curve-closer";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE as curvePolicy } from "../domain/demand-curve-policy";
import { MARKET_ESTIMATE_LAUNCH_POLICY_VALUE as estimatePolicy } from "../domain/estimate-policy";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE as hygienePolicy } from "../../market-trades/domain/stat-hygiene-policy";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE as observationPolicy } from "../../price-signals/domain/provider-observation-policy";
import { effectiveSaleAmountExact } from "../../price-signals/domain/effective-sale-price";
import { generateSyntheticProviderObservationFixture } from "../../price-signals/tests/fixtures/provider-observations/generate-fixture";

const sink = vi.hoisted(() => ({ written: [] as any[] }));
vi.mock("../read-model/demand-curve-writes", () => ({
  getDemandCurveCursor: async () => null,
  saveDemandCurveCursor: async () => true,
  supersedeDemandCurve: async () => true,
  writeDemandCurve: async (_pool: unknown, _store: unknown, input: unknown) => {
    sink.written.push(input);
    return "built";
  },
  curveFingerprint: (input: unknown) => JSON.stringify(input),
  demandCurveModelVersion: "pooled-supply-v1",
}));

const fixture = generateSyntheticProviderObservationFixture();
const capture = fixture.capture;
const now = capture.header.captureStartedAt;
const catalogItemId = capture.header.catalogItemId;
const productId = `${catalogItemId}::synthetic-boundary-regression`;
const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/app-recorded-ninety-day-oracle.json", import.meta.url), "utf8"),
) as { points: readonly OraclePoint[] };

type OraclePoint = {
  percentile: number;
  price: number;
  buyerIntervalDays: number;
  sellers: number;
  medianSellDays: number;
  qualifyingSaleCount: number;
};

type RawSale = ReturnType<typeof fixtureRows>[number];

function fixtureRows() {
  return capture.sales.map((sale) => ({
    sale_fingerprint: sale.saleFingerprint,
    observed_occurrence_count: sale.observedOccurrenceCount,
    provider_condition: sale.providerCondition,
    provider_variant: sale.providerVariant,
    provider_language: sale.providerLanguage,
    listing_type: sale.listingType,
    sold_at: sale.soldAt,
    quantity: sale.quantity,
    unit_price: sale.unitPrice,
    order_shipping: sale.orderShipping,
    capture_id: capture.header.captureId,
    capture_started_at: now,
    currency: "USD",
    observation_policy_revision_id: "synthetic-boundary-regression",
    sales_coverage: "complete",
  }));
}

function syntheticRows(count: number, multiplicity = 1): RawSale[] {
  const template = fixtureRows()[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    sale_fingerprint: `synthetic-boundary-${String(index).padStart(4, "0")}`,
    observed_occurrence_count: multiplicity,
    provider_condition: index % 2 ? "Lightly Played" : "Near Mint",
    sold_at: new Date(Date.parse(now) - Math.floor((count - 1 - index) / 2) * 3_600_000).toISOString(),
    quantity: 1,
    unit_price: "10.00",
    order_shipping: "0.00",
  }));
}

function policies(): PolicyRuntime {
  return {
    resolvePolicy: async ({ policyKey }: { policyKey: string }) => ({
      value:
        policyKey === "pricing.demand-curve"
          ? curvePolicy
          : policyKey === "pricing.market-estimate"
            ? estimatePolicy
            : policyKey === "pricing.market-stat-hygiene"
              ? hygienePolicy
              : observationPolicy,
      documentId: null,
    }),
  } as unknown as PolicyRuntime;
}

async function run(rows: RawSale[], observedSupply = false) {
  const pool = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      const result = (values: unknown[]) => ({ rows: values, rowCount: values.length });
      if (statement.includes("WITH bindings AS"))
        return result([
          {
            catalog_item_id: catalogItemId,
            product_id: productId,
            provider_condition: "Near Mint",
            provider_variant: "Normal",
            provider_language: "English",
            priority: 0,
          },
        ]);
      if (statement.includes("COUNT(*)::text AS count")) return result([{ count: "0" }]);
      if (statement.includes("FROM pricing_external_weekly_sale_buckets"))
        return result([
          {
            external_key: "sku:synthetic-boundary",
            week_start: "2026-08-31",
            catalog_product_key: productId,
            provider_condition: "Near Mint",
            provider_variant: "Normal",
            provider_language: "English",
            provider_market_amount: null,
            last_capture_id: capture.header.captureId,
            last_observed_at: now,
          },
        ]);
      if (statement.includes("FROM pricing_external_sale_observations"))
        return result(
          [...rows].sort(
            (left, right) =>
              Date.parse(left.sold_at) - Date.parse(right.sold_at) ||
              left.sale_fingerprint.localeCompare(right.sale_fingerprint),
          ),
        );
      if (statement.includes("FROM pricing_market_trades")) return result([]);
      if (statement.includes("FROM pricing_external_listing_snapshots"))
        return result(
          observedSupply
            ? [
                {
                  provider_variant: "Normal",
                  provider_language: "English",
                  provider_condition: "Near Mint",
                  observed_on: now.slice(0, 10),
                  last_capture_id: capture.header.captureId,
                  last_observed_at: now,
                  listings_coverage: "complete",
                },
              ]
            : [],
        );
      if (statement.includes("capture.own_seller_exclusion_applied"))
        return result([{ own_seller_exclusion_applied: false }]);
      if (statement.includes("FROM pricing_external_listing_ask_depth"))
        return result(
          capture.askDepth.map((ask) => ({
            capture_id: capture.header.captureId,
            anonymous_capture_seller_ordinal: ask.anonymousCaptureSellerOrdinal,
            provider_condition: ask.providerCondition,
            delivered_amount: ask.deliveredAmount,
            coverage: "complete",
          })),
        );
      if (statement.includes("FROM pricing_external_market_captures"))
        return result(
          observedSupply
            ? [
                {
                  capture_id: capture.header.captureId,
                  capture_started_at: now,
                  listings_status: "observed",
                  listings_coverage: "complete",
                  sales_status: "observed",
                  sales_coverage: "complete",
                },
              ]
            : [],
        );
      throw new Error(`Unrouted SQL: ${statement.slice(0, 100)}`);
    },
  };
  const outcome = await createDemandCurveCloser({
    pool: pool as never,
    eventStore: {} as never,
    policies: policies(),
  }).runDemandCurveCloser({ now, limit: 10 });
  const written = sink.written.at(-1);
  return { outcome, written, selected: written ? JSON.parse(written.fingerprint).sales : [] };
}

function expectedSelection(rows: RawSale[]) {
  const groups = new Map<string, RawSale>();
  for (const row of rows) {
    if (
      row.provider_variant !== "Normal" ||
      row.provider_language !== "English" ||
      !["All", "ListingWithPhotos", "ListingWithoutPhotos"].includes(row.listing_type)
    )
      continue;
    const prior = groups.get(row.sale_fingerprint);
    if (!prior || prior.observed_occurrence_count < row.observed_occurrence_count)
      groups.set(row.sale_fingerprint, row);
  }
  const relevant = [...groups.values()];
  const expandedCount = relevant.reduce((count, row) => count + row.observed_occurrence_count, 0);
  relevant.sort(
    (left, right) =>
      (expandedCount > curvePolicy.salesLimit ? Date.parse(right.sold_at) - Date.parse(left.sold_at) : 0) ||
      left.sale_fingerprint.localeCompare(right.sale_fingerprint),
  );
  return relevant
    .flatMap((row) =>
      Array.from({ length: row.observed_occurrence_count }, () => ({
        price: effectiveSaleAmountExact(
          { quantity: row.quantity, unitPrice: Number(row.unit_price), orderShipping: Number(row.order_shipping) },
          Number(observationPolicy.freeShippingThreshold),
        ),
        soldAt: row.sold_at,
        condition: row.provider_condition,
        variant: row.provider_variant,
        language: row.provider_language,
        source: "external-comp",
        coverage: row.sales_coverage === "complete" ? "complete" : "truncated",
      })),
    )
    .slice(0, curvePolicy.salesLimit);
}

describe("demand-curve closer production boundary", () => {
  beforeEach(() => {
    sink.written.length = 0;
  });

  it("matches the unchanged app oracle at the provider-builder write boundary", async () => {
    const rows = fixtureRows();
    const output = await run(rows, true);
    expect(output.outcome.built).toBe(1);
    expect(output.written.supplyStatus).toBe("observed");
    for (const [index, expected] of oracle.points.entries()) {
      const actual = output.written.points[index]!;
      expect(
        Math.abs(Number(actual.priceAmount) - expected.price),
        `P${expected.percentile} price`,
      ).toBeLessThanOrEqual(0.01);
      expect(relativeError(actual.buyerArrivalIntervalDays, expected.buyerIntervalDays)).toBeLessThanOrEqual(0.01);
      expect(relativeError(actual.medianSellDays, expected.medianSellDays)).toBeLessThanOrEqual(0.01);
      expect(actual.competingSellerCount).toBe(expected.sellers);
      expect(actual.qualifyingSaleCount).toBe(expected.qualifyingSaleCount);
    }
    expect(output.selected).toEqual(expectedSelection(rows));
  });

  it.each([
    ["below-cap", 99, 1],
    ["exact-cap", 100, 1],
    ["overflow", 101, 1],
    ["multiplicity-exact-cap", 50, 2],
    ["multiplicity-crossing-cap", 51, 2],
  ])("keeps the conditional expanded sequence for %s", async (_name, count, multiplicity) => {
    const rows = syntheticRows(count, multiplicity);
    const output = await run(rows);
    expect(output.outcome.built).toBe(1);
    expect(output.selected).toEqual(expectedSelection(rows));
    expect(output.written.exposureStartReason).toBe(
      count * multiplicity >= curvePolicy.salesLimit ? "sales-cap" : "history-window",
    );
  });

  it("counts maximum multiplicity after relevance filtering and preserves incomplete coverage", async () => {
    const base = syntheticRows(50, 2);
    const rows = [
      ...base,
      ...base.map((row) => ({
        ...row,
        capture_id: "synthetic-second-capture",
        observed_occurrence_count: 1,
        sales_coverage: "unknown",
      })),
      ...syntheticRows(3).map((row, index) => ({
        ...row,
        sale_fingerprint: `synthetic-irrelevant-${index}`,
        observed_occurrence_count: 101,
        provider_variant: index === 0 ? "Foil" : "Normal",
        provider_language: index === 1 ? "Japanese" : "English",
        listing_type: index === 2 ? "invalid" : row.listing_type,
      })),
    ];
    const output = await run(rows);
    expect(output.outcome.built).toBe(1);
    expect(output.selected).toEqual(expectedSelection(rows).map((sale) => ({ ...sale, coverage: "truncated" })));
    expect(output.selected).toHaveLength(100);
    expect(output.written.salesCoverage).not.toBe("complete");
  });
});

function relativeError(actual: number | null, expected: number): number {
  return actual === null ? Infinity : Math.abs(actual - expected) / Math.max(expected, 1e-9);
}
