import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  buildSavedListValuationCollectionProjectionHandlers,
  buildSavedListValuationPricingProjectionHandlers,
} from "./projection";

describe("Saved List valuation projections", () => {
  it("projects one Pricing row and observes matching lists without fanout writes", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ affected_list_count: "25000" }] });
    const observe = vi.fn();
    const handlers = buildSavedListValuationPricingProjectionHandlers({ query } as unknown as PgQueryable, {
      marketEstimateProjected: observe,
    });

    await handlers["pricing.market-price.estimated"]?.({
      data: {
        schemaVersion: 1,
        catalogItemId: "cat_one",
        productId: "prd_one",
        estimateVersion: "estimate-1",
        window: { startedAt: "2026-07-01T00:00:00.000Z", endedAt: "2026-07-13T10:00:00.000Z" },
        amount: "10.00",
        currencyCode: "usd",
        band: null,
        confidence: "high",
        estimatedAt: "2026-07-13T10:00:00.000Z",
        freshUntil: "2026-07-14T10:00:00.000Z",
        disclosure: "account",
      },
      globalPosition: "99",
      timing: { recordedAt: "2026-07-13T10:01:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("collections_saved_list_market_estimates");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("UPDATE collections_saved_list_valuation_lines");
    expect(observe).toHaveBeenCalledWith({ productId: "prd_one", affectedListCount: 25000, strategy: "join-on-read" });
  });

  it("uses source versions for idempotent Saved List line changes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const handlers = buildSavedListValuationCollectionProjectionHandlers({ query } as unknown as PgQueryable);
    await handlers["collections.saved-list.line-changed"]?.({
      data: { listId: "svl_one", lineId: "sll_one", trackedQuantity: 4, changedAt: "2026-07-13T10:00:00.000Z" },
      streamVersion: 7,
    } as never);

    expect(String(query.mock.calls[0]?.[0])).toContain("source_version < $4");
    expect(query.mock.calls[0]?.[1]).toEqual(["svl_one", "sll_one", 4, 7, "2026-07-13T10:00:00.000Z"]);
  });
});
