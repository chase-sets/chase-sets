import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createMarketplaceListingMcpHandlers } from "./mcp";
import type { MarketplaceListingServices } from "./runtime";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { marketplaceCanonicalRequest } from "../../mutation-recovery/domain/contracts";

const attempt = (
  key: string,
  kind: Parameters<typeof marketplaceCanonicalRequest>[0],
  request: Record<string, unknown>,
) => ({
  idempotencyKey: key,
  requestHash: hashMarketplaceRequest(marketplaceCanonicalRequest(kind, request)),
});
const createAttempt = attempt("mcp_create_attempt_000001", "listing.create", {
  inventoryItemId: "inv_1",
  priceAmount: "20.00",
  priceCurrencyCode: "USD",
  quantityCap: 2,
  purchaseLimits: { maxUnitsPerOrder: 1 },
});
const priceAttempt = attempt("mcp_price_attempt_0000001", "listing.update-price", {
  listingId: "lst_1",
  priceAmount: "24.00",
  priceCurrencyCode: "EUR",
});
const publishAttempt = attempt("mcp_publish_attempt_00001", "listing.publish", { listingId: "lst_1" });
const unpublishAttempt = attempt("mcp_unpublish_attempt_001", "listing.pause", { listingId: "lst_1" });

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
    listSellerListings: vi.fn(async () => ({
      items: [
        {
          listing_id: "lst_1",
          account_id: "acc_1",
          status: "active",
          price_amount: "20.00",
        },
      ],
      total: 1,
    })),
    getSellerListingAvailability: vi.fn(async (accountId) => ({
      account_id: accountId,
      status: "available",
      disabled_reason_category: null,
      available_again_on: null,
      available_again_at: null,
      disabled_at: null,
      enabled_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    })),
    listSellerListingFeeLockReport: vi.fn(async () => ({
      items: [{ listing_id: "lst_1", price_amount: "20.00", seller_net_unit_amount: "19.00" }],
      total: 1,
    })),
    listSellerInventoryItemSupply: vi.fn(async () => ({
      items: [{ item_id: "inv_1", available_quantity: 3 }],
      total: 1,
    })),
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
  it("lists seller listings through the Marketplace listing read model", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.list-listings"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1", limit: 10, offset: 5 },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({ accountId: "acc_1", total: 1, count: 1 });
    expect(fakeServices.listSellerListings).toHaveBeenCalledWith({
      accountId: "acc_1",
      limit: 10,
      offset: 5,
    });
  });

  it("returns seller insight reads from current Marketplace read models", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.get-seller-insights"]?.({
      actor,
      tool: null as never,
      arguments: { accountId: "acc_1", catalogItemId: "cat_1", limit: 10 },
      request: new Request("https://api.test/mcp"),
      protocol: legacyMcpProtocol,
    });

    expect(result).toMatchObject({
      accountId: "acc_1",
      availability: { status: "available" },
      listings: { total: 1, count: 1 },
      feeLockReport: { total: 1, count: 1 },
      supply: { total: 1, count: 1 },
    });
    expect(fakeServices.listSellerInventoryItemSupply).toHaveBeenCalledWith({
      accountId: "acc_1",
      catalogItemId: "cat_1",
      limit: 10,
      offset: 0,
    });
  });

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
        priceCurrencyCode: "USD",
        quantityCap: 2,
        purchaseLimits: { maxUnitsPerOrder: 1 },
        ...createAttempt,
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
        priceCurrencyCode: "USD",
        quantityCap: 2,
        purchaseLimits: {
          maxUnitsPerOrder: 1,
          maxUnitsPerDay: null,
          maxUnitsPerCustomerAccount: null,
        },
        ...createAttempt,
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
        priceCurrencyCode: "EUR",
        feeQuoteFingerprint: "24.00|1.20|22.80|cts_default|",
        ...priceAttempt,
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
        priceCurrencyCode: "EUR",
        feeQuoteFingerprint: "24.00|1.20|22.80|cts_default|",
        ...priceAttempt,
      },
      expect.objectContaining({
        audit: expect.objectContaining({ performedByUserId: "usr_1", forAccountId: "acc_1" }),
      }),
    );
  });

  it("rejects incomplete, malformed, and open price authoring arguments at the MCP boundary", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);
    const create = handlers.toolHandlers["marketplace.create-listing"]!;
    const baseArguments = {
      accountId: "acc_1",
      inventoryItemId: "inv_1",
      priceAmount: "20.00",
      quantityCap: 1,
    };

    for (const argumentsValue of [
      baseArguments,
      { ...baseArguments, priceCurrencyCode: "US" },
      { ...baseArguments, priceCurrencyCode: "USD", guessedCurrency: "EUR" },
      { ...baseArguments, priceCurrencyCode: "USD", purchaseLimits: { maxUnitsPerOrder: 1, guessed: 2 } },
    ]) {
      await expect(
        create({
          actor,
          tool: null as never,
          arguments: argumentsValue,
          request: new Request("https://api.test/mcp"),
          protocol: legacyMcpProtocol,
        }),
      ).rejects.toThrow();
    }

    expect(fakeServices.createListing).not.toHaveBeenCalled();
  });

  it("publishes and unpublishes listings through transport-agnostic handlers", async () => {
    const fakeServices = services();
    const handlers = createMarketplaceListingMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["marketplace.publish-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1", ...publishAttempt },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ listingId: "lst_1", version: 3, status: "published" });
    await expect(
      handlers.toolHandlers["marketplace.unpublish-listing"]?.({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", listingId: "lst_1", ...unpublishAttempt },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ listingId: "lst_1", version: 4, status: "unpublished" });

    expect(fakeServices.publishListing).toHaveBeenCalledWith(
      { accountId: "acc_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1", ...publishAttempt },
      expect.any(Object),
    );
    expect(fakeServices.pauseListing).toHaveBeenCalledWith(
      { accountId: "acc_1", listingId: "lst_1", ...unpublishAttempt },
      expect.any(Object),
    );
  });

  it.each([
    [
      "marketplace.create-listing",
      { inventoryItemId: "inv_1", priceAmount: "20.00", priceCurrencyCode: "USD", quantityCap: 2 },
    ],
    ["marketplace.update-listing-price", { listingId: "lst_1", priceAmount: "24.00", priceCurrencyCode: "EUR" }],
    ["marketplace.publish-listing", { listingId: "lst_1" }],
    ["marketplace.unpublish-listing", { listingId: "lst_1" }],
  ])("%s rejects a missing attempt or hash before any Listing service call", async (tool, args) => {
    const fakeServices = services();
    const handler = createMarketplaceListingMcpHandlers(fakeServices).toolHandlers[tool]!;
    const call = (extra: Record<string, unknown>) =>
      handler({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", ...args, ...extra },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      });
    await expect(call({})).rejects.toMatchObject({ code: "invalid_attempt" });
    await expect(call({ idempotencyKey: "mcp_missing_hash_0000001" })).rejects.toMatchObject({
      code: "invalid_attempt",
    });
    await expect(call({ requestHash: "a".repeat(64) })).rejects.toMatchObject({ code: "invalid_attempt" });
    await expect(call({ idempotencyKey: "short", requestHash: "a".repeat(64) })).rejects.toMatchObject({
      code: "invalid_attempt",
    });
    for (const method of ["createListing", "updateListingPrice", "publishListing", "pauseListing"] as const)
      expect(fakeServices[method]).not.toHaveBeenCalled();
  });

  it("replays exactly by forwarding the same attempt and hash unchanged on every retry", async () => {
    const fakeServices = services();
    const publish = createMarketplaceListingMcpHandlers(fakeServices).toolHandlers["marketplace.publish-listing"]!;
    const call = () =>
      publish({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_1", listingId: "lst_1", ...publishAttempt },
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      });
    await call();
    await call();
    const [first, second] = vi.mocked(fakeServices.publishListing).mock.calls.map(([params]) => params);
    expect(first).toMatchObject({ accountId: "acc_1", listingId: "lst_1", ...publishAttempt });
    expect(second).toEqual(first);
  });

  it("never lets a rail identity act for another account, even with a valid attempt", async () => {
    const fakeServices = services();
    const publish = createMarketplaceListingMcpHandlers(fakeServices).toolHandlers["marketplace.publish-listing"]!;
    await expect(
      publish({
        actor,
        tool: null as never,
        arguments: { accountId: "acc_other", listingId: "lst_1", ...publishAttempt },
        request: new Request("https://api.test/mcp", { headers: { "Idempotency-Key": "rail_key_for_acc_other_01" } }),
        protocol: legacyMcpProtocol,
      }),
    ).rejects.toThrow("accountId must match the authenticated actor account.");
    expect(fakeServices.publishListing).not.toHaveBeenCalled();
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
