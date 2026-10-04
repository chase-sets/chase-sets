import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { loadRepricingRoundInputs, loadRepricingRoundInputsPage, repricingProductKey } from "./queries";

const product = { catalogItemId: "cat_1", productId: "prd_1" };
const emptyRound = { listings: [], competingAsks: [], marketEstimate: null, lastSold: null };

function controlledReads(synchronousFailure?: number, error?: unknown) {
  const reads = Array.from({ length: 4 }, () => Promise.withResolvers<PgQueryResult<unknown>>());
  const started = vi.fn();
  const db: PgQueryable = {
    query: <Row>(sql: string, values?: readonly unknown[]) => {
      const index = started.mock.calls.length;
      started(sql, values);
      if (index === synchronousFailure) throw error;
      return reads[index]!.promise as Promise<PgQueryResult<Row>>;
    },
  };
  return { db, reads, started };
}

function observe<T>(work: Promise<T>) {
  let settled = false;
  const outcome = work.then(
    (value) => {
      settled = true;
      return { value };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  return { outcome, isSettled: () => settled };
}

const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
const loaders = [
  { name: "page", load: (db: PgQueryable) => loadRepricingRoundInputsPage(db, { products: [product] }) },
  { name: "single product", load: (db: PgQueryable) => loadRepricingRoundInputs(db, product) },
] as const;

describe.each(loaders)("repricing input $name loader settlement", ({ name, load }) => {
  it("starts all four reads concurrently and retains successful results", async () => {
    const { db, reads, started } = controlledReads();
    const work = observe<unknown>(load(db));
    try {
      await checkpoint();
      expect(started).toHaveBeenCalledTimes(4);
      expect(work.isSettled()).toBe(false);
      const keys = { catalog_catalog_item_id: product.catalogItemId, product_id: product.productId };
      reads[0]!.resolve({ rows: [] });
      reads[1]!.resolve({
        rows: [
          {
            ...keys,
            listing_id: "lst_1",
            seller_account_id: "acc_1",
            amount: "12.00",
            price_currency_code: "USD",
            pricing_mode: "hard",
          },
        ],
      });
      reads[2]!.resolve({ rows: [{ ...keys, amount: "11.00", currency_code: "USD", fresh_until: "2026-10-05" }] });
      await checkpoint();
      expect(work.isSettled()).toBe(false);
      reads[3]!.resolve({
        rows: [{ ...keys, unit_price_amount: "10.00", currency_code: null, sold_at: "2026-10-04" }],
      });
      const round = {
        listings: [],
        competingAsks: [
          { listingId: "lst_1", sellerAccountId: "acc_1", amount: "12.00", currencyCode: "USD", pricingMode: "hard" },
        ],
        marketEstimate: { amount: "11.00", currencyCode: "USD", freshUntil: "2026-10-05" },
        lastSold: { amount: "10.00", currencyCode: null, soldAt: "2026-10-04" },
      };
      expect(await work.outcome).toEqual({
        value: name === "page" ? new Map([[repricingProductKey(product), round]]) : round,
      });
    } finally {
      reads.forEach((read) => read.resolve({ rows: [] }));
      await work.outcome;
    }
  });

  it.each([0, 1, 2, 3])("drains siblings after read %i rejects", async (failedIndex) => {
    const { db, reads, started } = controlledReads();
    const originalError = new Error(`read ${failedIndex} failed`);
    const work = observe<unknown>(load(db));
    try {
      await checkpoint();
      expect(started).toHaveBeenCalledTimes(4);
      reads[failedIndex]!.reject(originalError);
      await checkpoint();
      expect(work.isSettled()).toBe(false);
      reads.forEach((read, index) => {
        if (index !== failedIndex) read.resolve({ rows: [] });
      });
      expect(await work.outcome).toEqual({ error: originalError });
      expect(((await work.outcome) as { error: unknown }).error).toBe(originalError);
    } finally {
      reads.forEach((read) => read.resolve({ rows: [] }));
      await work.outcome;
    }
  });

  it.each([1, 2, 3])("drains started reads after synchronous query %i throws", async (failedIndex) => {
    const originalError = new Error("synchronous query failure");
    const { db, reads, started } = controlledReads(failedIndex, originalError);
    const work = observe<unknown>(load(db));
    try {
      await checkpoint();
      expect(started).toHaveBeenCalledTimes(4);
      expect(work.isSettled()).toBe(false);
      reads.forEach((read) => read.resolve({ rows: [] }));
      expect(((await work.outcome) as { error: unknown }).error).toBe(originalError);
    } finally {
      reads.forEach((read) => read.resolve({ rows: [] }));
      await work.outcome;
    }
  });

  it.each([
    [3, 0],
    [0, 3],
  ])("preserves the first observed error from read %i before late read %i", async (first, late) => {
    const { db, reads } = controlledReads();
    const originalError = new Error("first observed failure");
    const lateError = new Error("late sibling failure");
    const work = observe<unknown>(load(db));
    try {
      await checkpoint();
      reads[first]!.reject(originalError);
      await checkpoint();
      expect(work.isSettled()).toBe(false);
      reads[late]!.reject(lateError);
      await checkpoint();
      expect(work.isSettled()).toBe(false);
      reads.forEach((read) => read.resolve({ rows: [] }));
      expect(((await work.outcome) as { error: unknown }).error).toBe(originalError);
    } finally {
      reads.forEach((read) => read.resolve({ rows: [] }));
      await work.outcome;
    }
  });
});

describe("repricing input page boundaries", () => {
  it("uses four reads for 500 distinct products", async () => {
    const { db, reads, started } = controlledReads();
    const products = Array.from({ length: 500 }, (_, index) => ({
      catalogItemId: `cat_${index}`,
      productId: `prd_${index}`,
    }));
    const work = loadRepricingRoundInputsPage(db, { products });
    reads.forEach((read) => read.resolve({ rows: [] }));
    expect(await work).toEqual(new Map(products.map((key) => [repricingProductKey(key), emptyRound])));
    expect(started).toHaveBeenCalledTimes(4);
  });
  it("does not query for an empty page or an oversized page", async () => {
    const { db, started } = controlledReads();
    expect(await loadRepricingRoundInputsPage(db, { products: [] })).toEqual(new Map());
    await expect(
      loadRepricingRoundInputsPage(db, { products: Array.from({ length: 501 }, () => product) }),
    ).rejects.toThrow("Repricing pages cannot exceed 500 products.");
    expect(started).not.toHaveBeenCalled();
  });

  it("deduplicates keys and uses four queries at the 500-product boundary", async () => {
    const { db, reads, started } = controlledReads();
    const candidate = {
      sellerAccountId: "acc_1",
      body: { scope: { kind: "all-listings" as const }, excludedListingIds: [], rules: [], maxChangesPerDay: 3 },
    };
    const work = loadRepricingRoundInputsPage(db, { products: Array.from({ length: 500 }, () => product), candidate });
    reads.forEach((read) => read.resolve({ rows: [] }));
    expect(await work).toEqual(new Map([[repricingProductKey(product), emptyRound]]));
    expect(started).toHaveBeenCalledTimes(4);
    expect(started.mock.calls.map((call) => call[1])).toEqual([
      [["cat_1"], ["prd_1"], JSON.stringify(candidate)],
      ...Array.from({ length: 3 }, () => [["cat_1"], ["prd_1"]]),
    ]);
  });
});
