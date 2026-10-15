import { expect, vi } from "vitest";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createDemandCurveCloser } from "../../features/market-estimates/api/demand-curve-closer";
import {
  createCurveBuilderRegistry,
  type CurveBuilderDefinition,
} from "../../features/market-estimates/domain/demand-curve/curve-builder-registry";
import { deepFreeze, describeConformance, type ConformanceProperty } from "./kit";

// The closer composes its built-in builders per pass; recording what reaches
// the registry factory reads those production registrations without editing them.
const registered = vi.hoisted(() => ({ definitions: [] as unknown[] }));
vi.mock("../../features/market-estimates/domain/demand-curve/curve-builder-registry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../features/market-estimates/domain/demand-curve/curve-builder-registry")>();
  return {
    ...actual,
    createCurveBuilderRegistry: (initial: Parameters<typeof actual.createCurveBuilderRegistry>[0] = []) => {
      registered.definitions.push(...initial);
      return actual.createCurveBuilderRegistry(initial);
    },
  };
});
vi.mock("../../features/market-estimates/read-model/demand-curve-candidates", () => ({
  listDemandCurveCandidates: async () => ({ candidates: [], unmapped: 0 }),
}));
vi.mock("../../features/market-estimates/read-model/demand-curve-writes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../features/market-estimates/read-model/demand-curve-writes")>()),
  getDemandCurveCursor: async () => null,
  saveDemandCurveCursor: async () => true,
}));

const asOf = "2026-10-13T12:00:00.000Z";
const identity = {
  catalogItemId: "cat_conformance",
  productId: "cat_conformance::",
  condition: "Near Mint",
  variant: "Normal",
  language: "English",
} as const;
const window = {
  since: "2026-07-15T12:00:00.000Z",
  asOf,
  freeShippingThreshold: 5,
  salesLimit: 50,
} as const;
const evidence = { present: true };

const providerSale = (fingerprint: string, overrides: Record<string, unknown> = {}) => ({
  sale_fingerprint: fingerprint,
  observed_occurrence_count: 1,
  provider_condition: "Near Mint",
  provider_variant: "Normal",
  provider_language: "English",
  listing_type: "ListingWithPhotos",
  sold_at: "2026-10-01T12:00:00.000Z",
  quantity: 1,
  unit_price: "10.00",
  order_shipping: "0.00",
  capture_id: "capture_conformance",
  capture_started_at: asOf,
  currency: "usd",
  observation_policy_revision_id: "policy_conformance",
  sales_coverage: "complete",
  ...overrides,
});
const providerSales = [
  providerSale("sale-a"),
  providerSale("sale-b", { observed_occurrence_count: 2, unit_price: "12.00", sold_at: "2026-09-20T12:00:00.000Z" }),
  providerSale("sale-c", { provider_condition: "Lightly Played", unit_price: "8.00" }),
  providerSale("sale-foil", { provider_variant: "Foil", unit_price: "30.00" }),
];
const trade = (index: number, verified: boolean) => ({
  unit_price_amount: `${9 + index}.50`,
  currency_code: "USD",
  sold_at: new Date(Date.parse("2026-10-05T12:00:00.000Z") - index * 86_400_000),
  verified,
  buyer_account_id: `acc_buyer_${index}`,
});
const trades = [trade(0, true), trade(1, false), trade(2, true)];

/** Serves stored evidence by the table each read names, honoring a bound LIMIT as Postgres would. */
const pool = {
  query: async (sql: string, params: readonly unknown[] = []) => {
    const rows = !evidence.present
      ? []
      : sql.includes("pricing_external_sale_observations")
        ? providerSales
        : sql.includes("pricing_market_trades")
          ? trades
          : [];
    const limit = /LIMIT \$(\d+)/.exec(sql);
    return { rows: limit ? rows.slice(0, Number(params[Number(limit[1]) - 1])) : rows };
  },
} as unknown as PgTransactionalPool;

/** Every policy at its launch default, as a pass resolves it with no published document. */
const policies = {
  resolvePolicy: async ({ defaultValue }: { defaultValue: unknown }) => ({
    value: defaultValue,
    documentId: null,
    effectiveFrom: null,
  }),
} as unknown as PolicyRuntime;

let production: Promise<readonly CurveBuilderDefinition[]> | null = null;
/** One empty pass composes the production builders exactly as a real pass does. */
function productionCurveBuilders(): Promise<readonly CurveBuilderDefinition[]> {
  production ??= (async () => {
    const closer = createDemandCurveCloser({ pool, eventStore: {} as PostgresEventStore, policies });
    await closer.runDemandCurveCloser({ now: asOf, limit: 1 });
    const byId = new Map((registered.definitions as CurveBuilderDefinition[]).map((builder) => [builder.id, builder]));
    return [...byId.values()];
  })();
  return production;
}

async function load(builder: CurveBuilderDefinition, overrides: Partial<typeof window> = {}, present = true) {
  evidence.present = present;
  try {
    return await builder.load(deepFreeze({ ...identity }), deepFreeze({ ...window, ...overrides }));
  } finally {
    evidence.present = true;
  }
}

const curveSaleSources = new Set(["platform-verified-trade", "platform-trade", "external-comp"]);

/** The curve builder contract: evidence only, in the shape the merge reads; it never decides a price. */
const curveBuilderProperties: readonly ConformanceProperty<CurveBuilderDefinition>[] = [
  {
    name: "declares a nonempty id and version and a sale source it weighs",
    check: (builder) => {
      expect(builder.id.length > 0 && builder.version.length > 0).toBe(true);
      expect(curveSaleSources.has(builder.weightSource)).toBe(true);
    },
  },
  {
    name: "loads deterministically over frozen identity and window",
    check: async (builder) => {
      const first = await load(builder);
      expect(first.length, "the fixture evidence yields sales").toBeGreaterThan(0);
      expect(await load(builder)).toEqual(first);
    },
  },
  {
    name: "returns sales of the requested variant and language in one sale shape",
    check: async (builder) => {
      for (const sale of await load(builder)) {
        expect(sale).toMatchObject({ variant: identity.variant, language: identity.language });
        expect(Number.isFinite(sale.price) && sale.price > 0, `price ${sale.price}`).toBe(true);
        expect(sale.currencyCode).toMatch(/^[A-Z]{3}$/);
        expect(Number.isFinite(Date.parse(sale.soldAt)), `soldAt ${sale.soldAt}`).toBe(true);
        expect(curveSaleSources.has(sale.source)).toBe(true);
        expect(sale.condition.length > 0 && sale.coverage.length > 0).toBe(true);
      }
    },
  },
  {
    name: "never returns more sales than the window's limit",
    check: async (builder) => {
      for (const salesLimit of [1, 2]) expect((await load(builder, { salesLimit })).length).toBeLessThanOrEqual(salesLimit);
    },
  },
  {
    name: "returns no sales, stably, when no evidence is stored",
    check: async (builder) => {
      expect(await load(builder, {}, false)).toEqual([]);
      expect(await load(builder, {}, false)).toEqual([]);
    },
  },
];

describeConformance({
  registry: createCurveBuilderRegistry,
  entries: productionCurveBuilders,
  key: (builder) => `${builder.id}@${builder.version}`,
  properties: curveBuilderProperties,
});
