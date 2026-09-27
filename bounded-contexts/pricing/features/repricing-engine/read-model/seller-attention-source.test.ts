import { describe, expect, it, vi } from "vitest";
import {
  isSellerAttentionItem,
  SELLER_ATTENTION_SEVERITY_RANK,
  SELLER_ATTENTION_SOURCES,
  type SellerAttentionContext,
} from "@chase-sets/seller-attention-queue";
import {
  createRepricingAttentionSource,
  createRepricingAttentionSourceFromReadModel,
  toRepricingAttentionItems,
  type RepricingAttentionSummary,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-09-26T12:00:00.000Z" };

function summary(overrides: Partial<RepricingAttentionSummary> = {}): RepricingAttentionSummary {
  return {
    floorBinding: 0,
    pausedForMissingInput: 0,
    budgetExhaustedToday: [],
    haltEngaged: false,
    frozenProducts: [],
    ...overrides,
  };
}

const everyCondition = summary({
  floorBinding: 2341,
  pausedForMissingInput: 12,
  budgetExhaustedToday: [
    { policyId: "rpp_a", count: 4 },
    { policyId: "rpp_b", count: 1 },
  ],
  haltEngaged: true,
  frozenProducts: [
    {
      productKey: { catalogItemId: "cat_1", productId: "prd_1" },
      listingCount: 3,
      frozenUntil: "2026-09-26T14:00:00.000Z",
    },
  ],
});

describe("toRepricingAttentionItems", () => {
  it("emits nothing when no repricing condition needs the seller", () => {
    expect(toRepricingAttentionItems(summary(), CONTEXT)).toEqual([]);
  });

  it("maps every summary condition to one conformant item deep-linking to the Desk repricing list", () => {
    const items = toRepricingAttentionItems(everyCondition, CONTEXT);
    expect(items.map((item) => [item.id, item.summary.code, item.summary.params])).toEqual([
      ["pricing-repricing:halt", "repricing-halt-engaged", {}],
      ["pricing-repricing:floor-binding", "repricing-floor-binding", { count: 2341 }],
      ["pricing-repricing:paused-for-missing-input", "repricing-paused-for-missing-input", { count: 12 }],
      ["pricing-repricing:budget-exhausted:rpp_a", "repricing-budget-exhausted", { count: 4 }],
      ["pricing-repricing:budget-exhausted:rpp_b", "repricing-budget-exhausted", { count: 1 }],
      ["pricing-repricing:frozen:cat_1:prd_1", "repricing-frozen", { count: 3 }],
    ]);
    for (const item of items) {
      expect(isSellerAttentionItem(item, "pricing-repricing")).toBe(true);
      expect(item.entity).toBe("repricing-policy");
      expect(item.deepLink).toEqual({ surface: "repricing-policies", href: "/account/desk/repricing" });
      expect(item.observedAt).toBe(CONTEXT.now);
    }
  });

  it("never exceeds the source's declared peak severity", () => {
    const peak = SELLER_ATTENTION_SOURCES.find((source) => source.id === "pricing-repricing")!.peakSeverity;
    for (const item of toRepricingAttentionItems(everyCondition, CONTEXT)) {
      expect(SELLER_ATTENTION_SEVERITY_RANK[item.severity]).toBeLessThanOrEqual(SELLER_ATTENTION_SEVERITY_RANK[peak]);
    }
  });

  it("carries only counts, never product identity or freeze instants, in rendered params", () => {
    const params = toRepricingAttentionItems(everyCondition, CONTEXT).map((item) => item.summary.params);
    expect(JSON.stringify(params)).not.toMatch(/cat_1|prd_1|rpp_a|frozenUntil|2026-09-26T14/);
  });
});

describe("createRepricingAttentionSource", () => {
  it("loads the summary through the injected reader for the requested context", async () => {
    const loadSummary = vi.fn(async () => summary({ haltEngaged: true }));
    const source = createRepricingAttentionSource({ loadSummary });
    expect(source.id).toBe("pricing-repricing");
    expect(await source.load(CONTEXT)).toHaveLength(1);
    expect(loadSummary).toHaveBeenCalledWith(CONTEXT);
  });
});

function attentionQuery(floorBinding: number, projectedHaltEngaged = false) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("pricing_repricing_halts")) return { rows: [{ engaged: projectedHaltEngaged }] };
    if (sql.includes("GROUP BY policy_id")) return { rows: [] };
    if (sql.includes("frozen_until >")) return { rows: [] };
    if (sql.includes("floor_binding_since")) return { rows: [{ count: floorBinding }] };
    return { rows: [{ count: 0 }] };
  });
}

function haltAggregate(engaged: boolean) {
  return {
    getHalt: vi.fn(async () => ({
      engaged,
      engagedAt: engaged ? "2026-09-26T11:59:59.000Z" : null,
      releasedAt: null,
    })),
  };
}

describe("createRepricingAttentionSourceFromReadModel", () => {
  it("reads the account attention summary with the resolved floor-binding alert threshold", async () => {
    const query = attentionQuery(5);
    const resolvePolicy = vi.fn(async () => ({ value: { floorBindingAlertDays: 9 } }));
    const halt = haltAggregate(false);

    const items = await createRepricingAttentionSourceFromReadModel({ query } as never, halt, {
      resolvePolicy,
    } as never).load(CONTEXT);

    expect(items.map((item) => item.summary)).toEqual([{ code: "repricing-floor-binding", params: { count: 5 } }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("floor_binding_since"), ["acct-1", CONTEXT.now, 9]);
    for (const [, values] of query.mock.calls as unknown as [string, unknown[]][]) {
      expect(values[0]).toBe("acct-1");
    }
    expect(halt.getHalt).toHaveBeenCalledWith("acct-1");
  });

  // The Desk halt switch reads the halt aggregate. The queue must agree with it
  // while the halt projection row still says released.
  it("raises the halt item from the committed halt aggregate ahead of the halt projection", async () => {
    const resolvePolicy = vi.fn(async () => ({ value: { floorBindingAlertDays: 7 } }));

    const items = await createRepricingAttentionSourceFromReadModel(
      { query: attentionQuery(0) } as never,
      haltAggregate(true),
      { resolvePolicy } as never,
    ).load(CONTEXT);

    expect(items.map((item) => item.summary)).toEqual([{ code: "repricing-halt-engaged", params: {} }]);
  });

  it("drops the halt item once the halt aggregate is released, even while the projection still says engaged", async () => {
    const resolvePolicy = vi.fn(async () => ({ value: { floorBindingAlertDays: 7 } }));

    const items = await createRepricingAttentionSourceFromReadModel(
      { query: attentionQuery(0, true) } as never,
      haltAggregate(false),
      { resolvePolicy } as never,
    ).load(CONTEXT);

    expect(items).toEqual([]);
  });
});
