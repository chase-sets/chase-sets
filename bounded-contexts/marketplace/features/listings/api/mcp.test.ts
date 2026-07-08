import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createMarketplaceListingMcpHandlers } from "./mcp";
import type { MarketplaceListingServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["listings.view", "listings.manage"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function services(): MarketplaceListingServices {
  return {
    createListing: vi.fn(async () => ({
      listingId: "lst_1" as never,
      version: 1,
      feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
    })),
    updateListingPrice: vi.fn(async (params) => ({
      listingId: params.listingId,
      version: 2,
    })),
    publishListing: vi.fn(async (params) => ({
      listingId: params.listingId,
      version: 3,
    })),
    pauseListing: vi.fn(async (params) => ({
      listingId: params.listingId,
      version: 4,
    })),
    getSellerListing: vi.fn(async (listingId, accountId) => ({
      listing_id: listingId,
      account_id: accountId,
      status: "active",
    })),
  } as unknown as MarketplaceListingServices;
}

describe("marketplace listing MCP handlers", () => {
  it("creates draft listings through the Marketplace listing service and returns a receipt", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.create-listing"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        quantityCap: 2,
        purchaseLimits: { maxUnitsPerOrder: 1 },
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      id: "lst_1",
      listingId: "lst_1",
      version: 1,
      status: "draft",
      resourceUri: "chase-sets://marketplace/acc_1/listings/lst_1",
      inventoryItemId: "inv_1",
      feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
    });
    expect(fakeServices.createListing).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1" as AccountId,
        inventoryItemId: "inv_1",
        priceAmount: "20.00",
        quantityCap: 2,
        purchaseLimits: {
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: null,
          maxUnitsPerCustomerAccount: null,
        },
      }),
      expect.objectContaining({
        audit: {
          performedByUserId: "usr_1",
          forAccountId: "acc_1",
        },
      }),
    );
  });

  it("updates listing prices with actor-scoped command context", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.update-listing-price"]?.({
      actor,
      tool: null as never,
      arguments: {
        accountId: "acc_1",
        listingId: "lst_1",
        priceAmount: "24.00",
        feeQuoteFingerprint: "24.00|1.20|22.80|cts_default|",
      },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ listingId: "lst_1", version: 2, status: "price-updated" });
    expect(fakeServices.updateListingPrice).toHaveBeenCalledWith(
      {
        accountId: "acc_1",
        listingId: "lst_1",
        priceAmount: "24.00",
        feeQuoteFingerprint: "24.00|1.20|22.80|cts_default|",
      },
      expect.objectContaining({
        audit: expect.objectContaining({ performedByUserId: "usr_1", forAccountId: "acc_1" }),
      }),
    );
  });

  it("publishes and unpublishes listings through transport-agnostic handlers", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.publish-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1" },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ listingId: "lst_1", version: 3, status: "published" });
    await expect(
      handlers.toolHandlers["marketplace.unpublish-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", listingId: "lst_1" },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ listingId: "lst_1", version: 4, status: "unpublished" });

    expect(fakeServices.publishListing).toHaveBeenCalledWith(
      { accountId: "acc_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1" },
      expect.any(Object),
    );
    expect(fakeServices.pauseListing).toHaveBeenCalledWith(
      { accountId: "acc_1", listingId: "lst_1" },
      expect.any(Object),
    );
  });

  it("rejects account mismatches and dry-run writes before mutating listings", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.publish-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other", listingId: "lst_1" },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    await expect(
      handlers.toolHandlers["marketplace.create-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", inventoryItemId: "inv_1", priceAmount: "20.00", quantityCap: 1, dryRun: true },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("dryRun is not supported for marketplace listing MCP writes yet.");
    expect(fakeServices.publishListing).not.toHaveBeenCalled();
    expect(fakeServices.createListing).not.toHaveBeenCalled();
  });

  it("reads listing resources by URI", async () => {
    const handlers = createMarketplaceListingMcpHandlers(services());

    const result = await handlers.resourceHandlers["chase-sets://marketplace/{accountId}/listings/{listingId}"]?.({
      actor,
      resource: null as never,
      uri: "chase-sets://marketplace/acc_1/listings/lst_1",
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      listing_id: "lst_1",
      account_id: "acc_1",
      status: "active",
    });
  });
});
