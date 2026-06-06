import { describe, expect, it } from "vitest";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingMarketplaceInputProjectionHandlers,
} from "./source-projection";

describe("pricing marketplace source projection", () => {
  it("projects catalog item language and resolved English display text", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingCatalogInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["catalog.catalog-item.created"]?.({
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_1",
      streamVersion: 1,
      data: {
        itemId: "cat_1",
        languageCode: "ja",
        title: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
        subtitle: { defaultLocale: "en", values: { en: "Japanese Base Set", ja: "拡張パック" } },
      },
      timing: {
        recordedAt: "2026-05-09T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("pricing_catalog_item_inputs");
    expect(calls[0]?.params).toEqual(["cat_1", "ja", "Charizard", "Japanese Base Set", "2026-05-09T00:00:00.000Z"]);
  });

  it("updates catalog input labels from Catalog display identity facts", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingCatalogInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["catalog.catalog-item.display-identity-resolved"]?.({
      type: "catalog.catalog-item.display-identity-resolved",
      streamId: "catalog.item-cat_1",
      streamVersion: 1,
      data: {
        catalogItemId: "cat_1",
        languageCode: "en",
        title: "Charizard 4/102",
        subtitle: "Base Set Rare Holo",
      },
      timing: {
        recordedAt: "2026-05-09T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("UPDATE pricing_catalog_item_inputs");
    expect(calls[0]?.params).toEqual([
      "cat_1",
      "en",
      "Charizard 4/102",
      "Base Set Rare Holo",
      "2026-05-09T00:00:00.000Z",
    ]);
  });

  it("projects listing targets needed for repricing recommendations", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingMarketplaceInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["marketplace.listing.created"]?.({
      type: "marketplace.listing.created",
      streamId: "marketplace.listing-lst_1",
      streamVersion: 1,
      data: {
        listingId: "lst_1",
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        priceAmount: "20.00",
        quantityCap: 2,
      },
      timing: {
        recordedAt: "2026-05-09T00:00:00.000Z",
      },
    } as never);

    expect(calls[0]?.sql).toContain("pricing_market_listing_inputs");
    expect(calls[0]?.sql).toContain("inventory_item_id");
    expect(calls[0]?.params).toEqual([
      "lst_1",
      "acc_1",
      "inv_1",
      "cat_1",
      "prod_1",
      "20.00",
      2,
      "2026-05-09T00:00:00.000Z",
    ]);
  });
});
