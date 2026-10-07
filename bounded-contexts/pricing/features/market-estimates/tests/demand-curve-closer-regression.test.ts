import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createDemandCurveCloser } from "../api/demand-curve-closer";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../domain/demand-curve-policy";
import { MARKET_ESTIMATE_LAUNCH_POLICY_VALUE } from "../domain/estimate-policy";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../../price-signals/domain/provider-observation-policy";

const writes = vi.hoisted(() => ({
  supersede: vi.fn(async (..._args: unknown[]) => true),
  saveCursor: vi.fn(async (..._args: unknown[]) => true),
  write: vi.fn(
    async (
      _pool: unknown,
      _store: unknown,
      _input: {
        fingerprint: string;
        exposureStartReason: string;
        points: readonly { priceAmount: string; historyCapped: boolean }[];
      },
    ) => "built" as const,
  ),
}));
vi.mock("../read-model/demand-curve-writes", () => ({
  getDemandCurveCursor: async () => null,
  saveDemandCurveCursor: writes.saveCursor,
  supersedeDemandCurve: writes.supersede,
  writeDemandCurve: writes.write,
  curveFingerprint: (value: unknown) => JSON.stringify(value),
  demandCurveModelVersion: "pooled-supply-v1",
}));

const now = "2026-09-01T15:00:00.000Z";
const catalogItemId = "cat_synthetic_curve_regression";
const productId = `${catalogItemId}::synthetic-product-key`;
const salesLimit = DEMAND_CURVE_LAUNCH_POLICY_VALUE.salesLimit;

function policies(conditionOrder = DEMAND_CURVE_LAUNCH_POLICY_VALUE.conditionOrder): PolicyRuntime {
  return {
    resolvePolicy: async (definition: { policyKey: string }) => ({
      value:
        definition.policyKey === "pricing.demand-curve"
          ? { ...DEMAND_CURVE_LAUNCH_POLICY_VALUE, conditionOrder }
          : definition.policyKey === "pricing.market-estimate"
            ? MARKET_ESTIMATE_LAUNCH_POLICY_VALUE
            : definition.policyKey === "pricing.market-stat-hygiene"
              ? MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE
              : PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
      documentId: null,
    }),
  } as unknown as PolicyRuntime;
}

function fakePool(input: {
  condition: string;
  provider?: readonly Record<string, unknown>[];
  platform?: readonly Record<string, unknown>[];
}) {
  const sql: string[] = [];
  const pool = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      sql.push(statement);
      const rows = (values: readonly unknown[]) => ({ rows: values, rowCount: values.length });
      if (statement.includes("WITH bindings AS"))
        return rows([
          {
            catalog_item_id: catalogItemId,
            product_id: productId,
            provider_condition: input.condition,
            provider_variant: "Normal",
            provider_language: "English",
            priority: 0,
          },
        ]);
      if (statement.includes("COUNT(*)::text AS count")) return rows([{ count: "0" }]);
      if (statement.includes("FROM pricing_external_weekly_sale_buckets"))
        return rows([
          {
            external_key: "sku:synthetic",
            week_start: "2026-08-31",
            catalog_product_key: productId,
            provider_condition: input.condition,
            provider_variant: "Normal",
            provider_language: "English",
            provider_market_amount: null,
            last_capture_id: "synthetic-capture",
            last_observed_at: now,
          },
        ]);
      if (statement.includes("FROM pricing_external_market_captures")) return rows([]);
      if (statement.includes("FROM pricing_external_sale_observations")) return rows(input.provider ?? []);
      if (statement.includes("FROM pricing_market_trades"))
        return rows((input.platform ?? []).slice(0, Number(parameters?.[4])));
      if (statement.includes("FROM pricing_external_listing_snapshots")) return rows([]);
      throw new Error(`Unrouted SQL: ${statement.slice(0, 100)}`);
    },
  };
  return { pool, sql };
}

function providerSales() {
  return Array.from({ length: salesLimit + 1 }, (_, index) => ({
    sale_fingerprint: `synthetic-sale-${String(index).padStart(4, "0")}`,
    observed_occurrence_count: 1,
    provider_condition: "Near Mint",
    provider_variant: "Normal",
    provider_language: "English",
    listing_type: "ListingWithPhotos",
    sold_at: new Date(Date.parse(now) - (index + 1) * 3_600_000).toISOString(),
    quantity: 1,
    unit_price: index === salesLimit ? "1000.00" : "10.00",
    order_shipping: "0.00",
    capture_id: "synthetic-capture",
    capture_started_at: now,
    currency: "USD",
    observation_policy_revision_id: "synthetic",
    sales_coverage: "complete",
  }));
}

describe("demand-curve closer regressions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["Unopened", DEMAND_CURVE_LAUNCH_POLICY_VALUE.conditionOrder],
    ["Damaged", DEMAND_CURVE_LAUNCH_POLICY_VALUE.conditionOrder.filter((condition) => condition !== "Damaged")],
  ])("supersedes a bound %s curve excluded by the active policy without reading evidence", async (condition, order) => {
    const { pool, sql } = fakePool({ condition });
    const result = await createDemandCurveCloser({
      pool: pool as never,
      eventStore: {} as never,
      policies: policies(order),
    }).runDemandCurveCloser({ now, limit: 1 });
    expect(result).toMatchObject({ built: 0, superseded: 1, unknownCondition: 1 });
    expect(writes.supersede).toHaveBeenCalledWith(pool, expect.objectContaining({ productId }), now);
    expect(writes.saveCursor).toHaveBeenCalledWith(pool, null, expect.objectContaining({ productId }), now);
    expect(writes.write).not.toHaveBeenCalled();
    expect(sql.some((statement) => statement.includes("SELECT external_key, week_start::text"))).toBe(false);
  });

  it("builds a capped curve from the latest provider sales, not the oldest outlier", async () => {
    const { pool } = fakePool({ condition: "Near Mint", provider: providerSales() });
    const result = await createDemandCurveCloser({
      pool: pool as never,
      eventStore: {} as never,
      policies: policies(),
    }).runDemandCurveCloser({ now });
    expect(result.built).toBe(1);
    expect(writes.write).toHaveBeenCalledWith(
      pool,
      expect.anything(),
      expect.objectContaining({
        exposureStartReason: "sales-cap",
        points: expect.arrayContaining([expect.objectContaining({ historyCapped: true })]),
      }),
    );
    expect(
      writes.write.mock.calls[0]?.[2].points.every((point: { priceAmount: string }) => Number(point.priceAmount) < 100),
    ).toBe(true);
    const selected = JSON.parse(writes.write.mock.calls[0]![2].fingerprint).sales as { price: number }[];
    expect(selected).toHaveLength(salesLimit);
    expect(selected.every((sale) => sale.price < 100)).toBe(true);
  });

  it("builds a capped curve from distinct platform pairs with a recency-ordered outer limit", async () => {
    const platform = Array.from({ length: salesLimit + 1 }, (_, index) => ({
      unit_price_amount: index === salesLimit ? "1000.00" : "10.00",
      sold_at: new Date(Date.parse(now) - (index + 1) * 3_600_000),
      verified: false,
      buyer_account_id: `buyer_synthetic_${index}`,
    }));
    const { pool, sql } = fakePool({ condition: "Near Mint", platform });
    const result = await createDemandCurveCloser({
      pool: pool as never,
      eventStore: {} as never,
      policies: policies(),
    }).runDemandCurveCloser({ now });
    expect(result.built).toBe(1);
    expect(writes.write.mock.calls[0]?.[2]).toMatchObject({ exposureStartReason: "sales-cap" });
    expect(writes.write.mock.calls[0]?.[2].points[0].historyCapped).toBe(true);
    const selected = JSON.parse(writes.write.mock.calls[0]![2].fingerprint).sales as { price: number }[];
    expect(selected).toHaveLength(salesLimit);
    expect(selected.every((sale) => sale.price < 100)).toBe(true);
    expect(sql.find((statement) => statement.includes("FROM pricing_market_trades"))).toMatch(
      /\) AS \w+\s+ORDER BY sold_at DESC,\s*order_id DESC,\s*line_id DESC LIMIT \$5/,
    );
  });
});
