import { describe, expect, it } from "vitest";
import {
  buildPricingCatalogInputProjectionHandlers,
  buildPricingInventoryInputProjectionHandlers,
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
    expect(calls[0]?.params).toEqual([
      "cat_1",
      "ja",
      "Charizard",
      "Japanese Base Set",
      "charizard-japanese-base-set-cat-1-5e05dn",
      "2026-05-09T00:00:00.000Z",
    ]);
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
      "charizard-4-102-base-set-rare-holo-cat-1-5e05dn",
      "2026-05-09T00:00:00.000Z",
    ]);
  });

  it("does not handle Catalog metadata revisions as catalog input label changes", () => {
    const handlers = buildPricingCatalogInputProjectionHandlers({
      query: async () => ({ rows: [] }),
    });

    expect(handlers["catalog.catalog-item.metadata-revised"]).toBeUndefined();
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

  it("projects catalog item category assignment for repricing-policy catalog-filter scope resolution (#4330)", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingCatalogInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["catalog.catalog-item.category-assigned"]?.({
      type: "catalog.catalog-item.category-assigned",
      streamId: "catalog.item-cat_1",
      streamVersion: 2,
      data: { categoryId: "cat_electronics" },
      timing: { recordedAt: "2026-05-09T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("category_ids = ARRAY(SELECT DISTINCT unnest(category_ids");
    expect(calls[0]?.params).toEqual(["cat_1", "cat_electronics", "2026-05-09T00:00:00.000Z"]);
  });

  it("projects catalog item category removal", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingCatalogInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["catalog.catalog-item.category-removed"]?.({
      type: "catalog.catalog-item.category-removed",
      streamId: "catalog.item-cat_1",
      streamVersion: 3,
      data: { categoryId: "cat_electronics" },
      timing: { recordedAt: "2026-05-09T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("array_remove(category_ids");
    expect(calls[0]?.params).toEqual(["cat_1", "cat_electronics", "2026-05-09T00:00:00.000Z"]);
  });

  it("projects the acquisition cost basis fact for repricing-policy cost-basis floors (#4330)", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingInventoryInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["inventory.item.created"]?.({
      type: "inventory.item.created",
      streamId: "inventory.item-inv_1",
      streamVersion: 1,
      data: {
        itemId: "inv_1",
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        totalQuantity: 3,
        acquisitionCostAmount: "6.50",
      },
      timing: { recordedAt: "2026-05-09T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("acquisition_cost_amount");
    expect(calls[0]?.params).toEqual(["inv_1", "acc_1", "cat_1", "prod_1", 3, "6.50", "2026-05-09T00:00:00.000Z", 1]);
  });

  it("stores a null acquisition cost basis when the inventory item omits it", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const handlers = buildPricingInventoryInputProjectionHandlers({
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    });

    await handlers["inventory.item.created"]?.({
      type: "inventory.item.created",
      streamId: "inventory.item-inv_2",
      streamVersion: 1,
      data: {
        itemId: "inv_2",
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        totalQuantity: 3,
      },
      timing: { recordedAt: "2026-05-09T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.params).toEqual(["inv_2", "acc_1", "cat_1", "prod_1", 3, null, "2026-05-09T00:00:00.000Z", 1]);
  });
});
