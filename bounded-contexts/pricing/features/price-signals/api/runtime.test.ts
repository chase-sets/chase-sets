import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPriceSignalRuntime } from "./runtime";

class PriceSignalDb implements PgQueryable {
  public readonly references = new Map<string, { catalog_item_id: string; catalog_product_key: string }>();
  public readonly signals = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const values = params ?? [];
    if (sql.includes("FROM pricing_external_product_reference_inputs")) {
      const row = this.references.get(`${values[0]}:${values[1]}`);
      return { rows: row ? ([row] as Row[]) : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes("INSERT INTO pricing_tcgplayer_price_signals")) {
      this.signals.set(String(values[0]), {
        signal_id: values[0],
        external_key: values[1],
        catalog_item_id: values[2],
        catalog_product_key: values[3],
        status: values[4],
        market_price_amount: values[5],
        lowest_price_amount: values[6],
        highest_price_amount: values[7],
        price_count: values[8],
        calculated_at: values[9],
        observed_at: values[10],
        stale_after: values[11],
        source_payload: JSON.parse(String(values[12])),
        recommendation_payload: JSON.parse(String(values[13])),
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe("TCGplayer price signal runtime", () => {
  it("resolves SKU references to Catalog Product keys before recording Pricing evidence", async () => {
    const db = new PriceSignalDb();
    db.references.set("tcgplayer:sku:9001001", {
      catalog_item_id: "cat_1",
      catalog_product_key: "cat_1::condition:near_mint|printing:holofoil",
    });

    const result = await createPriceSignalRuntime({ db }).recordTcgplayerPriceSignal({
      skuId: 9001001,
      observedAt: "2026-06-03T00:00:00.000Z",
      pricePoint: {
        skuId: 9001001,
        marketPrice: 184.22,
        lowestPrice: 175,
        highestPrice: 220,
        priceCount: 9,
        calculatedAt: "2026-06-02T23:00:00.000Z",
      },
      latestSales: { data: [{ purchasePrice: 181.5 }] },
      listings: { results: [{ totalResults: 4 }] },
      priceHistory: { count: 1 },
      recommendation: { algorithm: "latest-sales-percentile", portDecision: "adapt" },
    });

    expect(result).toMatchObject({
      status: "recorded",
      signal: {
        externalKey: "sku:9001001",
        catalogItemId: "cat_1",
        catalogProductKey: "cat_1::condition:near_mint|printing:holofoil",
        status: "current",
        marketPriceAmount: "184.22",
      },
    });
    expect(db.signals.size).toBe(1);
    expect([...db.signals.values()][0]).toMatchObject({
      market_price_amount: "184.22",
      recommendation_payload: { algorithm: "latest-sales-percentile", portDecision: "adapt" },
    });
  });

  it("keeps unresolved SKU signals out of price facts for review", async () => {
    const db = new PriceSignalDb();

    const result = await createPriceSignalRuntime({ db }).recordTcgplayerPriceSignal({
      skuId: 9001001,
      observedAt: "2026-06-03T00:00:00.000Z",
      pricePoint: { skuId: 9001001, marketPrice: 184.22, calculatedAt: "2026-06-03T00:00:00.000Z" },
    });

    expect(result).toEqual({
      status: "unresolved",
      reason: "sku-reference-not-mapped",
      externalKey: "sku:9001001",
    });
    expect(db.signals.size).toBe(0);
  });

  it("records missing and stale price points without publishing listing changes", async () => {
    const db = new PriceSignalDb();
    db.references.set("tcgplayer:sku:9001001", {
      catalog_item_id: "cat_1",
      catalog_product_key: "cat_1::condition:near_mint",
    });

    const missing = await createPriceSignalRuntime({ db }).recordTcgplayerPriceSignal({
      skuId: 9001001,
      observedAt: "2026-06-03T00:00:00.000Z",
      pricePoint: { skuId: 9001001, marketPrice: null, calculatedAt: "2026-06-03T00:00:00.000Z" },
    });
    const stale = await createPriceSignalRuntime({ db }).recordTcgplayerPriceSignal({
      skuId: 9001001,
      observedAt: "2026-06-03T00:00:00.000Z",
      pricePoint: { skuId: 9001001, marketPrice: 184.22, calculatedAt: "2026-05-30T00:00:00.000Z" },
    });

    expect(missing).toMatchObject({ status: "recorded", signal: { status: "missing-price" } });
    expect(stale).toMatchObject({ status: "recorded", signal: { status: "stale" } });
    expect(db.signals.size).toBe(1);
  });

  it("upserts replayed observations by deterministic signal id", async () => {
    const db = new PriceSignalDb();
    db.references.set("tcgplayer:sku:9001001", {
      catalog_item_id: "cat_1",
      catalog_product_key: "cat_1::condition:near_mint",
    });
    const runtime = createPriceSignalRuntime({ db });
    const input = {
      skuId: 9001001,
      observedAt: "2026-06-03T00:00:00.000Z",
      pricePoint: { skuId: 9001001, marketPrice: 184.22, calculatedAt: "2026-06-03T00:00:00.000Z" },
    };

    await runtime.recordTcgplayerPriceSignal(input);
    await runtime.recordTcgplayerPriceSignal({ ...input, pricePoint: { ...input.pricePoint, marketPrice: 180 } });

    expect(db.signals.size).toBe(1);
    expect([...db.signals.values()][0]?.market_price_amount).toBe("180.00");
  });
});
