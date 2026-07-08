import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createMarketplaceOfferMcpHandlers } from "./mcp";
import type { MarketplaceOfferServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["offers.view", "offers.manage", "listings.view"],
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

function offerRow(overrides: Record<string, unknown> = {}) {
  return {
    offer_id: "off_1",
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::condition:near-mint",
    item_title: "Charizard",
    item_subtitle: null,
    selected_options: [{ dimensionId: "condition", optionId: "near-mint" }],
    product_summary: null,
    shipping_destination_snapshot: {
      name: "Buyer",
      line1: "1 Main",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    price_amount: "20.00",
    quantity_requested: 1,
    status: "submitted",
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function services(): MarketplaceOfferServices {
  return {
    submitOffer: vi.fn(async (params) => ({
      offerId: params.offerId ?? "off_1",
      version: 1,
    })),
    acceptOffer: vi.fn(async (params) => ({
      offerId: params.offerId,
      version: 2,
    })),
    declineOfferMatch: vi.fn(async (params) => ({
      offerId: params.offerId,
      version: 3,
    })),
    listSubmittedOffers: vi.fn(async () => ({
      items: [offerRow({ buyer_account_id: "acc_1" })],
      total: 1,
    })),
    listOfferMatches: vi.fn(async () => ({
      items: [
        offerRow({
          listing_id: "lst_1",
          listing_price_amount: "24.00",
          can_fulfill: true,
        }),
      ],
      total: 1,
    })),
    getSubmittedOffer: vi.fn(async (offerId, buyerAccountId) =>
      offerId === "off_1" ? offerRow({ offer_id: offerId, buyer_account_id: buyerAccountId }) : null,
    ),
    getOfferMatch: vi.fn(async (offerId) =>
      offerId === "off_match" ? offerRow({ offer_id: offerId, listing_id: "lst_1" }) : null,
    ),
  } as unknown as MarketplaceOfferServices;
}

const submitArgs = {
  accountId: "acc_1",
  catalogItemId: "cat_1",
  productId: "cat_1::condition:near-mint",
  itemTitle: "Charizard",
  selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
  shippingDestinationSnapshot: {
    name: "Buyer",
    line1: "1 Main",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  priceAmount: "20.00",
  quantityRequested: 1,
  offerIdOverride: "off_natural_1",
};

describe("marketplace offer MCP handlers", () => {
  it("submits buyer offers through the Marketplace offer service and returns a receipt", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceOfferMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.submit-offer"]?.(mcpRequest(submitArgs));

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "off_natural_1",
      offerId: "off_natural_1",
      version: 1,
      status: "submitted",
      resourceUri: "chase-sets://marketplace/acc_1/offers/off_natural_1",
      catalogItemId: "cat_1",
      productId: "cat_1::condition:near-mint",
    });
    expect(fakeServices.submitOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId: "off_natural_1",
        buyerAccountId: "acc_1",
        catalogItemId: "cat_1",
        priceAmount: "20.00",
        quantityRequested: 1,
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("records counter offers as new submitted offers with the countered offer in the MCP receipt", async () => {
    const handlers = createMarketplaceOfferMcpHandlers(services());

    const result = await handlers.toolHandlers["marketplace.counter-offer"]?.(
      mcpRequest({ ...submitArgs, counteredOfferId: "off_original" }),
    );

    expect(result).toMatchObject({
      offerId: "off_natural_1",
      status: "countered",
      counteredOfferId: "off_original",
    });
  });

  it("accepts and declines seller offer matches with actor-scoped command context", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceOfferMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.accept-offer"]?.(
        mcpRequest({
          accountId: "acc_1",
          offerId: "off_1",
          feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
          sourceActionKey: "mcp:accept:off_1",
        }),
      ),
    ).resolves.toMatchObject({ offerId: "off_1", version: 2, status: "accepted" });
    await expect(
      handlers.toolHandlers["marketplace.decline-offer"]?.(mcpRequest({ accountId: "acc_1", offerId: "off_1" })),
    ).resolves.toMatchObject({ offerId: "off_1", version: 3, status: "declined" });

    expect(fakeServices.acceptOffer).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_1",
        feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
        sourceActionKey: "mcp:accept:off_1",
      },
      expect.any(Object),
    );
    expect(fakeServices.declineOfferMatch).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_1",
      },
      expect.any(Object),
    );
  });

  it("lists buyer submitted offers and seller matched offers without private shipping snapshots", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceOfferMcpHandlers(fakeServices);

    const submitted = await handlers.toolHandlers["marketplace.list-offers"]?.(
      mcpRequest({ accountId: "acc_1", side: "submitted" }),
    );
    const matched = await handlers.toolHandlers["marketplace.list-offers"]?.(
      mcpRequest({ accountId: "acc_1", side: "matched", productIds: "prod_1, prod_2", canFulfill: true }),
    );

    expect(submitted).toMatchObject({ accountId: "acc_1", side: "submitted", total: 1, count: 1 });
    expect(JSON.stringify(submitted)).not.toContain("shipping_destination_snapshot");
    expect(matched).toMatchObject({ accountId: "acc_1", side: "matched", total: 1, count: 1 });
    expect(JSON.stringify(matched)).not.toContain("shipping_destination_snapshot");
    expect(fakeServices.listOfferMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerAccountId: "acc_1",
        productIds: ["prod_1", "prod_2"],
        canFulfill: true,
      }),
    );
  });

  it("rejects account mismatches, missing seller listing visibility, and dry-run writes before mutating", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceOfferMcpHandlers(fakeServices);
    const buyerOnlyActor = { ...actor, permissions: ["offers.view", "offers.manage"] };

    await expect(
      handlers.toolHandlers["marketplace.submit-offer"]?.(mcpRequest({ ...submitArgs, accountId: "acc_other" })),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    await expect(
      handlers.toolHandlers["marketplace.submit-offer"]?.(mcpRequest({ ...submitArgs, dryRun: true })),
    ).rejects.toThrow("dryRun is not supported for marketplace offer MCP writes yet.");
    await expect(
      handlers.toolHandlers["marketplace.accept-offer"]?.(
        mcpRequest({ accountId: "acc_1", offerId: "off_1" }, buyerOnlyActor),
      ),
    ).rejects.toThrow("Missing required permission: listings.view.");

    expect(fakeServices.submitOffer).not.toHaveBeenCalled();
    expect(fakeServices.acceptOffer).not.toHaveBeenCalled();
  });

  it("reads offer resources by URI from the buyer or seller side", async () => {
    const handlers = createMarketplaceOfferMcpHandlers(services());

    const submitted = await handlers.resourceHandlers["chase-sets://marketplace/{accountId}/offers/{offerId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://marketplace/acc_1/offers/off_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });
    const matched = await handlers.resourceHandlers["chase-sets://marketplace/{accountId}/offers/{offerId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://marketplace/acc_1/offers/off_match",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(submitted).toMatchObject({ offer_id: "off_1", buyer_account_id: "acc_1" });
    expect(JSON.stringify(submitted)).not.toContain("shipping_destination_snapshot");
    expect(matched).toMatchObject({ offer_id: "off_match", listing_id: "lst_1" });
    expect(JSON.stringify(matched)).not.toContain("shipping_destination_snapshot");
  });
});
