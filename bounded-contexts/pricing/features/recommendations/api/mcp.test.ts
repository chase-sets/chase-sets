import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createPricingRecommendationMcpHandlers } from "./mcp";
import type { PricingRecommendationServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["pricing.view", "pricing.manage"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

function recommendationRow(overrides: Record<string, unknown> = {}) {
  return {
    recommendation_id: "rec_1",
    catalog_catalog_item_id: "cat_1",
    seller_account_id: "acc_1",
    action_type: "active-listing-price-update",
    status: "proposed",
    listing_id: "lst_1",
    inventory_item_id: "inv_1",
    catalog_item_title: "Charizard",
    catalog_item_language_code: "en",
    catalog_item_subtitle: null,
    catalog_item_status: "active",
    market_price_amount: 20,
    market_currency: "USD",
    market_signal_type: "competition",
    market_observed_at: "2026-07-08T00:00:00.000Z",
    current_price_amount: 22,
    recommended_list_amount: 19.99,
    recommendation_reason: "Priced one cent below the lowest competing active listing.",
    quantity_cap: 1,
    applied_listing_id: null,
    last_error: null,
    recommendation_published_at: "2026-07-08T00:00:00.000Z",
    stock_on_hand_quantity: 3,
    stock_reserved_quantity: 1,
    active_listing_count: 2,
    lowest_listing_price_amount: 20,
    active_offer_count: 1,
    highest_offer_price_amount: 18,
    committed_order_quantity: 0,
    delivered_quantity: 0,
    returned_quantity: 0,
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function services(): PricingRecommendationServices {
  return {
    recommendAccountPrice: vi.fn(async () => ({ items: [recommendationRow()], total: 1 })),
    explainAccountPricingSignals: vi.fn(async (params) => ({
      accountId: params.accountId,
      catalogItemId: params.catalogItemId,
      productId: params.productId ?? null,
      inventory: {
        stockOnHandQuantity: 3,
        stockReservedQuantity: 1,
        availableQuantity: 2,
      },
      market: {
        activeListingCount: 2,
        lowestListingPriceAmount: 20,
        activeOfferCount: 1,
        highestOfferPriceAmount: 18,
      },
      orders: {
        committedOrderQuantity: 0,
      },
      fulfillment: {
        deliveredQuantity: 0,
        returnedQuantity: 0,
      },
      recommendations: [recommendationRow()],
    })),
  } as unknown as PricingRecommendationServices;
}

describe("pricing recommendation MCP handlers", () => {
  it("returns existing account recommendations for a Catalog Item natural key", async () => {
    const fakeServices = services();
    const handlers = createPricingRecommendationMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["pricing.recommend-price"]?.(
      mcpRequest({ accountId: "acc_1", catalogItemId: "cat_1", limit: 5 }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      total: 1,
      count: 1,
      recommendedPriceAmount: 19.99,
      recommendationId: "rec_1",
      resourceUri: "chase-sets://pricing/catalog-items/cat_1/recommendations",
    });
    expect(fakeServices.recommendAccountPrice).toHaveBeenCalledWith({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      limit: 5,
      offset: 0,
    });
  });

  it("explains pricing signals with optional product natural key filtering", async () => {
    const fakeServices = services();
    const handlers = createPricingRecommendationMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["pricing.explain-signals"]?.(
      mcpRequest({ accountId: "acc_1", catalogItemId: "cat_1", productId: "prod_1" }),
    );

    expect(result).toMatchObject({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "prod_1",
      inventory: { availableQuantity: 2 },
      market: { lowestListingPriceAmount: 20 },
    });
    expect(fakeServices.explainAccountPricingSignals).toHaveBeenCalledWith({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      productId: "prod_1",
    });
  });

  it("rejects account mismatches before reading pricing recommendations", async () => {
    const fakeServices = services();
    const handlers = createPricingRecommendationMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["pricing.recommend-price"]?.(
        mcpRequest({ accountId: "acc_other", catalogItemId: "cat_1" }),
      ),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.recommendAccountPrice).not.toHaveBeenCalled();
  });

  it("reads recommendation resources for the actor account", async () => {
    const fakeServices = services();
    const handlers = createPricingRecommendationMcpHandlers(fakeServices);

    const result = await handlers.resourceHandlers[
      "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations"
    ]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://pricing/catalog-items/cat_1/recommendations",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ total: 1, items: [expect.objectContaining({ recommendation_id: "rec_1" })] });
    expect(fakeServices.recommendAccountPrice).toHaveBeenCalledWith({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      limit: 10,
      offset: 0,
    });
  });
});
