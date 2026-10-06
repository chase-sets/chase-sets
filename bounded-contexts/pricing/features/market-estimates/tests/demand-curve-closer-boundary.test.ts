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
import type { CurveSale } from "../domain/demand-curve/curve-builder-registry";

const sink = vi.hoisted(() => ({ written: [] as WrittenCurve[] }));
vi.mock("../read-model/demand-curve-writes", () => ({
  getDemandCurveCursor: async () => null,
  saveDemandCurveCursor: async () => true,
  supersedeDemandCurve: async () => true,
  writeDemandCurve: async (_pool: unknown, _store: unknown, input: WrittenCurve) => {
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
type WrittenCurve = {
  fingerprint: string;
  supplyStatus: string;
  exposureStartReason: string;
  salesCoverage: string;
  points: readonly {
    priceAmount: string;
    buyerArrivalIntervalDays: number | null;
    medianSellDays: number | null;
    competingSellerCount: number | null;
    qualifyingSaleCount: number;
    historyCapped: boolean;
  }[];
};

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

async function run(
  rows: RawSale[],
  observedSupply = false,
  options: {
    platform?: RawSale[];
    emptySupply?: boolean;
    configure?: (closer: ReturnType<typeof createDemandCurveCloser>) => void;
    passes?: number;
    policyRuntime?: PolicyRuntime;
  } = {},
) {
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
      if (statement.includes("FROM pricing_market_trades"))
        return result(
          [...(options.platform ?? [])]
            .sort((left, right) => Date.parse(right.sold_at) - Date.parse(left.sold_at))
            .slice(0, Number(parameters?.[4]))
            .map((row) => ({
              unit_price_amount: row.unit_price,
              sold_at: new Date(row.sold_at),
              verified: false,
              buyer_account_id: row.sale_fingerprint,
            })),
        );
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
          (options.emptySupply ? [] : capture.askDepth).map((ask) => ({
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
  const closer = createDemandCurveCloser({
    pool: pool as never,
    eventStore: {} as never,
    policies: options.policyRuntime ?? policies(),
  });
  options.configure?.(closer);
  let outcome = await closer.runDemandCurveCloser({ now, limit: 10 });
  for (let pass = 1; pass < (options.passes ?? 1); pass++)
    outcome = await closer.runDemandCurveCloser({ now, limit: 10 });
  const written = sink.written.at(-1)!;
  return { outcome, written, selected: (JSON.parse(written.fingerprint) as { sales: CurveSale[] }).sales };
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
    ["below-cap", 99, 1, [0, 1, 2, 3], [95, 96, 97, 98]],
    ["exact-cap", 100, 1, [0, 1, 2, 3], [96, 97, 98, 99]],
    ["overflow", 101, 1, [99, 100, 97, 98], [3, 4, 1, 2]],
    ["multiplicity-exact-cap", 50, 2, [0, 0, 1, 1], [48, 48, 49, 49]],
    ["multiplicity-crossing-cap", 51, 2, [49, 49, 50, 50], [1, 1, 2, 2]],
  ] as const)("keeps the conditional expanded sequence for %s", async (_name, count, multiplicity, first, last) => {
    const rows = syntheticRows(count, multiplicity);
    const output = await run(rows);
    expect(output.outcome.built).toBe(1);
    expect(output.selected).toEqual(expectedSelection(rows));
    const identity = (index: number) => ({ condition: rows[index]!.provider_condition, soldAt: rows[index]!.sold_at });
    expect(output.selected.slice(0, 4)).toMatchObject(first.map(identity));
    expect(output.selected.slice(-4)).toMatchObject(last.map(identity));
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

  it.each([
    ["provider", 101],
    ["provider", 150],
    ["platform", 101],
    ["platform", 150],
  ] as const)("retains pre-trim cap exposure for %s price-spread overflow %i", async (source, count) => {
    const rows = spreadRows(count);
    const output = await run(source === "provider" ? rows : [], true, {
      platform: source === "platform" ? rows : [],
      emptySupply: true,
    });
    expect(output.outcome.built).toBe(1);
    expect(output.selected).toHaveLength(100);
    expect(output.selected.map((sale) => sale.price).sort((a, b) => a - b)).toEqual(
      rows.slice(count - 100).map((row) => Number(row.unit_price)),
    );
    // Independently fixed recency ties; equal timestamps retain fingerprint order.
    expect(output.selected.slice(0, 3).map((sale) => sale.price)).toEqual(
      count === 101 ? [14.9, 15, 14.7] : [19.8, 19.9, 19.6],
    );
    assertCapped(output.written);
  });

  it.each([
    ["provider", 101],
    ["provider", 150],
    ["platform", 101],
    ["platform", 150],
  ] as const)("preserves ordered-input identity across %s deletion from %i sales", async (source, count) => {
    const rows = spreadRows(count).map((row, index) => ({
      ...row,
      sale_fingerprint: `synthetic-spread-${index + 1}`,
      sold_at: new Date(Date.parse(now) - (index + 1) * 3_600_000).toISOString(),
      unit_price: (5 + (index + 1) / 10).toFixed(2),
    }));
    // Independent fixture identities, not the production comparator or expectedSelection.
    const newestOrder = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
      32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
      60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87,
      88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
    ];
    const fingerprintOrder = [
      1, 10, 100, 11, 12, 13, 14, 15, 16, 17, 18, 19, 2, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 3, 30, 31, 32, 33, 34,
      35, 36, 37, 38, 39, 4, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 5, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 6, 60,
      61, 62, 63, 64, 65, 66, 67, 68, 69, 7, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 8, 80, 81, 82, 83, 84, 85, 86, 87,
      88, 89, 9, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    ];
    const prices = (order: readonly number[]) => order.map((n) => (50 + n) / 10);
    const build = (evidence: RawSale[], unusable = false) =>
      run(source === "provider" ? [...evidence, ...(unusable ? unusableRows() : [])] : [], true, {
        platform: source === "platform" ? evidence : [],
        emptySupply: true,
      });
    const overflow = await build(rows);
    expect(overflow.selected.map((sale) => sale.price)).toEqual(prices(newestOrder));
    assertCapped(overflow.written);
    const withUnusable = await build(rows, true);
    expect(withUnusable.selected).toEqual(overflow.selected);
    expect(withUnusable.written.fingerprint).toBe(overflow.written.fingerprint);
    expect(withUnusable.written.points).toEqual(overflow.written.points);
    if (count === 150) {
      const stillOverflow = await build(rows.slice(0, 101), true);
      expect(stillOverflow.selected).toEqual(overflow.selected);
      expect(stillOverflow.written.fingerprint).toBe(overflow.written.fingerprint);
      expect(stillOverflow.written.points).toEqual(overflow.written.points);
    }
    const exact = await build(rows.slice(0, 100), true);
    expect(exact.selected.map((sale) => sale.price)).toEqual(
      prices(source === "provider" ? fingerprintOrder : newestOrder),
    );
    expect([...exact.selected].sort((a, b) => a.price - b.price)).toEqual(overflow.selected);
    if (source === "provider") expect(exact.written.fingerprint).not.toBe(overflow.written.fingerprint);
    else {
      expect(exact.written.fingerprint).toBe(overflow.written.fingerprint);
      expect(exact.written.points).toEqual(overflow.written.points);
    }
    assertCapped(exact.written);
    const replay = await build(rows.slice(0, 100), true);
    expect(replay.selected).toEqual(exact.selected);
    expect(replay.written.fingerprint).toBe(exact.written.fingerprint);
    expect(replay.written.points).toEqual(exact.written.points);
  });

  it("excludes unknown and zero-price slot theft before the N20 overflow cap", async () => {
    const valid = spreadRows(101);
    const control = await run(valid, true, { emptySupply: true });
    const output = await run([...valid, ...unusableRows()], true, { emptySupply: true });
    expect(output.selected).toEqual(control.selected);
    expect(output.selected).toHaveLength(100);
    expect(output.selected.every((sale) => sale.condition === "Near Mint" && sale.price > 0)).toBe(true);
    expect(output.written.points).toEqual(control.written.points);
    assertCapped(output.written);
  });

  it.each([99, 100])("preserves fingerprint order with unusable evidence at %i usable sales", async (count) => {
    const valid = spreadRows(count);
    const output = await run([...valid, ...unusableRows()]);
    expect(output.selected.map((sale) => sale.price)).toEqual(valid.map((row) => Number(row.unit_price)));
    expect(output.selected.slice(0, 3).map((sale) => sale.price)).toEqual([5, 5.1, 5.2]);
    expect(output.selected.at(-1)?.price).toBe(count === 99 ? 14.8 : 14.9);
  });

  it("retains extra registrations across passes and rejects duplicate and reserved IDs", async () => {
    const load = vi.fn(
      async (): Promise<readonly CurveSale[]> => [
        {
          price: 12.34,
          soldAt: now,
          condition: "Near Mint",
          variant: "Normal",
          language: "English",
          source: "external-comp",
          coverage: "complete",
        },
      ],
    );
    await run(spreadRows(90), false, {
      passes: 2,
      configure: (closer) => {
        const definition = { id: "synthetic-extra", version: "1", weightSource: "external-comp" as const, load };
        closer.registerCurveBuilder(definition);
        for (const id of ["synthetic-extra", "provider-sales", "platform-trades"])
          expect(() => closer.registerCurveBuilder({ ...definition, id })).toThrow(/unique/);
      },
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(sink.written).toHaveLength(2);
    for (const written of sink.written) {
      const selected = (JSON.parse(written.fingerprint) as { sales: CurveSale[] }).sales;
      expect(selected).toHaveLength(91);
      expect(selected.at(-1)).toMatchObject({ price: 12.34 });
    }
  });

  it("uses the single resolved condition policy of each pass before counting", async () => {
    let curveReads = 0;
    const policyRuntime = {
      resolvePolicy: async (definition: { policyKey: string }) => {
        const resolved = await policies().resolvePolicy(definition as never);
        if (definition.policyKey !== "pricing.demand-curve") return resolved;
        curveReads++;
        return {
          ...resolved,
          value: {
            ...curvePolicy,
            conditionOrder: curveReads === 1 ? ["Near Mint", "Lightly Played"] : curvePolicy.conditionOrder,
          },
        };
      },
    } as unknown as PolicyRuntime;
    await run(
      [
        ...spreadRows(99),
        ...spreadRows(2).map((row, index) => ({
          ...row,
          sale_fingerprint: `synthetic-policy-${index}`,
          provider_condition: "Damaged",
          sold_at: now,
        })),
      ],
      false,
      { passes: 2, policyRuntime },
    );
    expect(curveReads).toBe(2);
    const selections = sink.written.map((written) => (JSON.parse(written.fingerprint) as { sales: CurveSale[] }).sales);
    expect(selections[0]).toHaveLength(99);
    expect(selections[0]!.every((sale) => sale.condition === "Near Mint")).toBe(true);
    expect(selections[1]).toHaveLength(100);
    expect(selections[1]!.filter((sale) => sale.condition === "Damaged")).toHaveLength(2);
  });
});

function spreadRows(count: number): RawSale[] {
  return syntheticRows(count).map((row, index) => ({
    ...row,
    provider_condition: "Near Mint",
    unit_price: (5 + index / 10).toFixed(2),
  }));
}

function unusableRows(): RawSale[] {
  return syntheticRows(2, 20).map((row, index) => ({
    ...row,
    sale_fingerprint: `synthetic-unusable-${index}`,
    sold_at: now,
    provider_condition: index === 0 ? "Unopened" : "Near Mint",
    unit_price: index === 0 ? "10.00" : "0.00",
  }));
}

function assertCapped(written: WrittenCurve): void {
  expect(written.exposureStartReason).toBe("sales-cap");
  expect(written.points).toHaveLength(19);
  for (const point of written.points) {
    expect(point.historyCapped).toBe(true);
    expect(point.buyerArrivalIntervalDays).not.toBeNull();
    expect(Number.isFinite(point.buyerArrivalIntervalDays)).toBe(true);
    expect(point.buyerArrivalIntervalDays).toBeGreaterThan(0);
    expect(point.medianSellDays).not.toBeNull();
    expect(Number.isFinite(point.medianSellDays)).toBe(true);
    expect(point.medianSellDays).toBeGreaterThan(0);
  }
}

function relativeError(actual: number | null, expected: number): number {
  return actual === null ? Infinity : Math.abs(actual - expected) / Math.max(expected, 1e-9);
}
