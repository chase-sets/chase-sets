import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createMarketplaceOfferMcpHandlers } from "./mcp";
import type { MarketplaceOfferServices } from "./runtime";
import { ManagedOfferConflictError } from "./managed-authority";
import { privatePolicyFields } from "../../offer-policy/tests/fixtures";
import { createMarketplaceOfferRuntime } from "./runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { buildListingEvidenceSnapshot } from "../../listings/domain/evidence-snapshot";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { marketplaceOfferCanonicalRequest } from "../../mutation-recovery/domain/contracts";
import type { OfferMatchRow } from "../read-model/queries";

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

function offerRow(overrides: Partial<OfferMatchRow> = {}): OfferMatchRow {
  return {
    ...privatePolicyFields,
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
    price_currency_code: "USD",
    last_stream_version: 1,
    accepted_listing_id: null,
    accepted_inventory_item_id: null,
    listing_evidence_policy_hash: null,
    listing_evidence_snapshot_hash: null,
    listing_id: "lst_1",
    listing_price_amount: "24.00",
    listing_price_currency_code: "USD",
    listing_stream_version: 2,
    listing_quantity_cap: 1,
    listing_visible_quantity: 1,
    offer_price_gap_amount: "4.00",
    offer_to_listing_price_bps: 8333,
    buyer_display_name: "Buyer",
    buyer_average_rating: null,
    buyer_review_count: 0,
    seller_available_quantity: 1,
    seller_listing_availability_status: "available",
    can_fulfill: true,
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
  const db = { query: async <Row>() => ({ rows: [] as Row[] }) };
  return {
    ...createMarketplaceOfferRuntime({
      eventStore: createInMemoryEventStore().eventStore,
      db,
      checkpointStore: createPostgresProjectionStore({ db }),
      commercialTermsResolver: createNoopCommercialTermsResolver(),
    }),
    submitOffer: vi.fn(async (params) => ({
      offerId: params.offerId ?? "off_1",
      version: 1,
    })),
    acceptOffer: vi.fn(async (params) => ({
      offerId: params.offerId,
      version: 2,
      listingId: params.listingId,
      inventoryItemId: "inv_one",
      listingEvidenceSnapshot: buildListingEvidenceSnapshot({ evidence: [], createdAt: "2026-01-01T00:00:00.000Z" }),
    })),
    declineOfferMatch: vi.fn(async (params) => ({
      offerId: params.offerId,
      version: 3,
    })),
    listSubmittedOffers: vi.fn(async () => ({
      items: [offerRow({ buyer_account_id: "acc_1" })],
      total: 1,
      statusCounts: { submitted: 1, paused: 0, withdrawn: 0, accepted: 0 },
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
  };
}

const submitArgs = {
  attemptId: "mcp_attempt_identity_0001",
  requestHash: "a".repeat(64),
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
  priceCurrencyCode: "USD",
  quantityRequested: 1,
  offerIdOverride: "off_natural_1",
};

describe("marketplace offer MCP handlers", () => {
  it.each([
    "marketplace.submit-offer",
    "marketplace.counter-offer",
    "marketplace.update-offer-price",
    "marketplace.accept-offer",
    "marketplace.decline-offer",
  ])("%s refuses missing attempt id or hash before the service", async (tool) => {
    const service = services();
    vi.spyOn(service, "updateOfferPrice");
    const handlers = createMarketplaceOfferMcpHandlers(service);
    const args = { ...submitArgs, counteredOfferId: "off_original", offerId: "off_one", listingId: "lst_one" };
    for (const field of ["attemptId", "requestHash"] as const) {
      const missing: Record<string, unknown> = { ...args };
      delete missing[field];
      await expect(handlers.toolHandlers[tool]!(mcpRequest(missing))).rejects.toThrow(field);
    }
    for (const method of [
      service.submitOffer,
      service.updateOfferPrice,
      service.acceptOffer,
      service.declineOfferMatch,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it("rail attempt identity never grants cross-account authority", async () => {
    const service = services();
    const handlers = createMarketplaceOfferMcpHandlers(service);
    await expect(
      handlers.toolHandlers["marketplace.submit-offer"]!(mcpRequest({ ...submitArgs, accountId: "acc_other" })),
    ).rejects.toThrow();
    expect(service.submitOffer).not.toHaveBeenCalled();
  });

  it.each(["marketplace.submit-offer", "marketplace.counter-offer"])(
    "%s replays a real runtime first receipt after response loss with no second append",
    async (tool) => {
      const store = createInMemoryEventStore().eventStore;
      const db = {
        query: async <Row>(sql: string) => ({
          rows: (sql.includes("FROM marketplace_catalog_items")
            ? [{ status: "active", product_schema: null }]
            : []) as Row[],
        }),
      };
      const service = createMarketplaceOfferRuntime({
        eventStore: store,
        db,
        checkpointStore: createPostgresProjectionStore({ db }),
        commercialTermsResolver: createNoopCommercialTermsResolver(),
      });
      const args = {
        ...submitArgs,
        productId: "cat_1::",
        selectedOptions: [],
        ...(tool.endsWith("counter-offer") ? { counteredOfferId: "off_original" } : {}),
      };
      const request = {
        offerId: args.offerIdOverride,
        ...(tool.endsWith("counter-offer") ? { counteredOfferId: "off_original" } : {}),
        catalogItemId: args.catalogItemId,
        productId: args.productId,
        itemTitle: args.itemTitle,
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: {
          ...args.shippingDestinationSnapshot,
          company: null,
          line2: null,
          phone: null,
          email: null,
        },
        priceAmount: args.priceAmount,
        priceCurrencyCode: args.priceCurrencyCode,
        quantityRequested: args.quantityRequested,
      };
      args.requestHash = hashMarketplaceRequest(marketplaceOfferCanonicalRequest("offer.submit", request));
      const handlers = createMarketplaceOfferMcpHandlers(service);
      const first = await handlers.toolHandlers[tool]!(mcpRequest(args));
      await expect(
        Promise.resolve().then(() => {
          throw new TypeError("injected response loss after commit");
        }),
      ).rejects.toThrow("loss");
      const append = vi.spyOn(store, "appendToStreams");
      expect(await handlers.toolHandlers[tool]!(mcpRequest(args))).toEqual(first);
      expect(append).not.toHaveBeenCalled();
      await expect(handlers.toolHandlers[tool]!(mcpRequest({ ...args, priceAmount: "21.00" }))).rejects.toMatchObject({
        code: "attempt_conflict",
      });
      expect(append).not.toHaveBeenCalled();
    },
  );
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
          listingId: "lst_1",
          feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
          sourceActionKey: "mcp:accept:off_1",
          attemptId: "mcp_attempt_identity_0002",
          requestHash: "b".repeat(64),
        }),
      ),
    ).resolves.toMatchObject({ offerId: "off_1", version: 2, status: "accepted" });
    await expect(
      handlers.toolHandlers["marketplace.decline-offer"]?.(
        mcpRequest({
          accountId: "acc_1",
          offerId: "off_1",
          attemptId: "mcp_attempt_identity_0003",
          requestHash: "c".repeat(64),
        }),
      ),
    ).resolves.toMatchObject({ offerId: "off_1", version: 3, status: "declined" });

    expect(fakeServices.acceptOffer).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_1",
        listingId: "lst_1",
        feeQuoteFingerprint: "20.00|1.00|19.00|cts_default|",
        sourceActionKey: "mcp_attempt_identity_0002",
        requestHash: "b".repeat(64),
      },
      expect.any(Object),
    );
    expect(fakeServices.declineOfferMatch).toHaveBeenCalledWith(
      {
        offerId: "off_1",
        sellerAccountId: "acc_1",
        attemptId: "mcp_attempt_identity_0003",
        requestHash: "c".repeat(64),
      },
      expect.any(Object),
    );
  });

  it("propagates managed refresh conflicts without silently requoting or retrying acceptance", async () => {
    const fake = services();
    vi.mocked(fake.acceptOffer).mockRejectedValue(new ManagedOfferConflictError("managed_offer_refresh_required"));
    const handlers = createMarketplaceOfferMcpHandlers(fake);
    await expect(
      handlers.toolHandlers["marketplace.accept-offer"]!(
        mcpRequest({
          accountId: "acc_1",
          offerId: "off_1",
          listingId: "lst_1",
          feeQuoteFingerprint: "old",
          attemptId: "mcp_attempt_identity_0004",
          requestHash: "d".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "managed_offer_refresh_required" });
    expect(fake.acceptOffer).toHaveBeenCalledTimes(1);
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
    for (const output of [submitted, matched]) {
      const serialized = JSON.stringify(output);
      for (const [key, value] of Object.entries(privatePolicyFields)) {
        expect(serialized).not.toContain(key);
        if (typeof value !== "object") expect(serialized).not.toContain(String(value));
      }
    }
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
    for (const output of [submitted, matched]) {
      const serialized = JSON.stringify(output);
      for (const [key, value] of Object.entries(privatePolicyFields)) {
        expect(serialized).not.toContain(key);
        if (typeof value !== "object") expect(serialized).not.toContain(String(value));
      }
    }
  });
});

describe("marketplace offer MCP price receipts", () => {
  it("reports the command result status, so a paused Offer's re-price receipt says paused", async () => {
    const fakeServices = {
      ...services(),
      updateOfferPrice: vi.fn(async () => ({ offerId: "off_1", version: 3, status: "paused" })),
    } as unknown as MarketplaceOfferServices;
    const handlers = createMarketplaceOfferMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["marketplace.update-offer-price"]?.(
      mcpRequest({
        accountId: "acc_1",
        offerId: "off_1",
        priceAmount: "21.00",
        priceCurrencyCode: "USD",
        attemptId: "paused_mcp_price_attempt_01",
        requestHash: "a".repeat(64),
      }),
    );

    expect(result).toMatchObject({ offerId: "off_1", version: 3, status: "paused" });
  });
});
