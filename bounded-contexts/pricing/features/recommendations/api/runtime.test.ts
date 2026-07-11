import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPricingRecommendationRuntime, type PricingMarketplaceListingGateway } from "./runtime";
import type { AccountRecommendationListItem } from "../read-model/queries";

const context: EventStoreContext = {
  tenantId: "ten_1" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_1" as never,
  },
};

function createMemoryEventStore() {
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const store: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        const streamVersion = existing.length + index + 1;
        return {
          eventId: `evt_${allEvents.length + index + 1}` as never,
          streamId: input.streamId,
          streamVersion,
          globalPosition: String(allEvents.length + index + 1) as never,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });
      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async ({ streamId }) => streams.get(streamId) ?? [],
    readAll: async () => allEvents,
  };

  return { store, allEvents };
}

function createRuntime(db: PgQueryable) {
  const eventStore = createMemoryEventStore();
  return {
    services: createPricingRecommendationRuntime({
      eventStore: eventStore.store,
      checkpointStore: {} as never,
      db,
    }),
    events: eventStore.allEvents,
  };
}

function queryStub(
  rowsByKind: Readonly<{
    listings?: readonly unknown[];
    inventory?: readonly unknown[];
    recommendations?: readonly AccountRecommendationListItem[];
  }>,
): PgQueryable {
  return {
    query: async <T>(sql: string) => {
      if (sql.includes("FROM pricing_inventory_item_inputs AS item")) {
        return { rows: (rowsByKind.inventory ?? []) as T[] };
      }
      if (sql.includes("FROM pricing_market_listing_inputs AS listing")) {
        return { rows: (rowsByKind.listings ?? []) as T[] };
      }
      if (sql.includes("FROM pricing_recommendation_feed")) {
        return { rows: (rowsByKind.recommendations ?? []) as T[] };
      }
      return { rows: [] as T[] };
    },
  };
}

const proposedRecommendation = {
  recommendation_id: "rec_active",
  catalog_catalog_item_id: "cat_1",
  catalog_item_language_code: "en",
  seller_account_id: "acc_1",
  action_type: "active-listing-price-update",
  status: "proposed",
  listing_id: "lst_1",
  inventory_item_id: "inv_1",
  catalog_item_title: "Charizard ex",
  catalog_item_subtitle: null,
  catalog_item_status: "active",
  market_price_amount: 18,
  market_currency: "USD",
  market_signal_type: "competition",
  market_observed_at: "2026-05-09T00:00:00.000Z",
  current_price_amount: 20,
  recommended_list_amount: 17.99,
  recommendation_reason: "Priced one cent below the lowest competing active listing.",
  quantity_cap: 1,
  applied_listing_id: null,
  last_error: null,
  recommendation_published_at: "2026-05-09T00:00:00.000Z",
  stock_on_hand_quantity: 1,
  stock_reserved_quantity: 0,
  active_listing_count: 2,
  lowest_listing_price_amount: 18,
  active_offer_count: 0,
  highest_offer_price_amount: null,
  committed_order_quantity: 0,
  delivered_quantity: 0,
  returned_quantity: 0,
  updated_at: "2026-05-09T00:00:00.000Z",
} satisfies AccountRecommendationListItem;

async function seedRecommendation(
  services: ReturnType<typeof createPricingRecommendationRuntime>,
  row: AccountRecommendationListItem,
) {
  await services.commandHandler({
    streamId: `pricing.recommendation-${row.recommendation_id}`,
    command: {
      type: "ProposeRecommendation",
      recommendationId: row.recommendation_id,
      catalogItemId: row.catalog_catalog_item_id,
      sellerAccountId: row.seller_account_id,
      actionType: row.action_type,
      listingId: row.listing_id,
      inventoryItemId: row.inventory_item_id,
      marketPriceAmount: row.market_price_amount,
      marketCurrency: row.market_currency,
      marketSignalType: row.market_signal_type,
      currentPriceAmount: row.current_price_amount,
      recommendedListAmount: row.recommended_list_amount ?? row.market_price_amount,
      reason: row.recommendation_reason ?? "Recommendation proposed.",
      quantityCap: row.quantity_cap,
      observedAt: row.market_observed_at,
    },
    context,
  });
}

describe("pricing recommendation runtime", () => {
  it("refreshes active listing and draft create proposals from projected signals", async () => {
    const { services, events } = createRuntime(
      queryStub({
        listings: [
          {
            action_type: "active-listing-price-update",
            seller_account_id: "acc_1",
            catalog_catalog_item_id: "cat_1",
            product_id: "prod_1",
            listing_id: "lst_1",
            inventory_item_id: "inv_1",
            current_price_amount: "20.00",
            quantity_cap: 1,
            competitor_price_amount: "18.00",
            offer_price_amount: null,
          },
          {
            action_type: "draft-listing-price-update",
            seller_account_id: "acc_1",
            catalog_catalog_item_id: "cat_skip",
            product_id: "prod_skip",
            listing_id: "lst_skip",
            inventory_item_id: "inv_skip",
            current_price_amount: "11.99",
            quantity_cap: 1,
            competitor_price_amount: "12.00",
            offer_price_amount: null,
          },
        ],
        inventory: [
          {
            seller_account_id: "acc_1",
            catalog_catalog_item_id: "cat_2",
            product_id: "prod_2",
            inventory_item_id: "inv_2",
            available_quantity: 3,
            competitor_price_amount: null,
            offer_price_amount: "5.00",
          },
          {
            seller_account_id: "acc_1",
            catalog_catalog_item_id: "cat_no_signal",
            product_id: "prod_no_signal",
            inventory_item_id: "inv_no_signal",
            available_quantity: 2,
            competitor_price_amount: null,
            offer_price_amount: null,
          },
        ],
      }),
    );

    const result = await services.refreshRecommendations({ accountId: "acc_1" }, context);

    expect(result.proposedCount).toBe(2);
    expect(events.map((event) => event.eventType)).toEqual([
      "pricing.recommendation.proposed",
      "pricing.recommendation.proposed",
    ]);
    expect(events[0]?.payload).toMatchObject({
      actionType: "active-listing-price-update",
      recommendedListAmount: 17.99,
      marketSignalType: "competition",
    });
    expect(events[1]?.payload).toMatchObject({
      actionType: "draft-listing-create",
      recommendedListAmount: 5,
      quantityCap: 3,
      marketSignalType: "offer",
    });
  });

  it("applies active listing updates through one batched Marketplace bulk call (m113 #4327)", async () => {
    const gateway: PricingMarketplaceListingGateway = {
      applyBulkListingPriceUpdates: vi.fn(async () => ({
        items: [{ listingId: "lst_1", outcome: "applied" as const, version: 2 }],
      })),
      createListing: vi.fn(async () => ({ id: "lst_created" })),
    };
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [proposedRecommendation],
      }),
    );
    await seedRecommendation(services, proposedRecommendation);

    const result = await services.applyRecommendations(
      {
        accountId: "acc_1",
        recommendationIds: ["rec_active"],
        marketplaceListings: gateway,
      },
      context,
    );

    expect(result).toEqual({ appliedCount: 1, failedCount: 0 });
    // Exactly ONE Marketplace round trip for the whole batch, not a
    // previewListingTerms + updateListingPrice pair per listing.
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledTimes(1);
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledWith(
      { updates: [{ listingId: "lst_1", priceAmount: "17.99" }] },
      expect.any(Object),
    );
    expect(events.at(-1)?.eventType).toBe("pricing.recommendation.applied");
  });

  it("batches multiple listing-price-update recommendations into a single Marketplace bulk call", async () => {
    const secondRecommendation = {
      ...proposedRecommendation,
      recommendation_id: "rec_active_2",
      listing_id: "lst_2",
      recommended_list_amount: 24.99,
    } satisfies AccountRecommendationListItem;
    const gateway: PricingMarketplaceListingGateway = {
      applyBulkListingPriceUpdates: vi.fn(async () => ({
        items: [
          { listingId: "lst_1", outcome: "applied" as const, version: 2 },
          { listingId: "lst_2", outcome: "applied" as const, version: 2 },
        ],
      })),
      createListing: vi.fn(async () => ({ id: "lst_created" })),
    };
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [proposedRecommendation, secondRecommendation],
      }),
    );
    await seedRecommendation(services, proposedRecommendation);
    await seedRecommendation(services, secondRecommendation);

    const result = await services.applyRecommendations(
      {
        accountId: "acc_1",
        recommendationIds: ["rec_active", "rec_active_2"],
        marketplaceListings: gateway,
      },
      context,
    );

    expect(result).toEqual({ appliedCount: 2, failedCount: 0 });
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledTimes(1);
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledWith(
      {
        updates: [
          { listingId: "lst_1", priceAmount: "17.99" },
          { listingId: "lst_2", priceAmount: "24.99" },
        ],
      },
      expect.any(Object),
    );
    expect(events.filter((event) => event.eventType === "pricing.recommendation.applied")).toHaveLength(2);
  });

  it("creates draft listings for unlisted inventory recommendations", async () => {
    const gateway: PricingMarketplaceListingGateway = {
      applyBulkListingPriceUpdates: vi.fn(async () => ({ items: [] })),
      createListing: vi.fn(async () => ({ id: "lst_created" })),
    };
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [
          {
            ...proposedRecommendation,
            recommendation_id: "rec_create",
            action_type: "draft-listing-create",
            listing_id: null,
            inventory_item_id: "inv_2",
            current_price_amount: null,
            recommended_list_amount: 5,
            quantity_cap: 3,
          },
        ],
      }),
    );
    await seedRecommendation(services, {
      ...proposedRecommendation,
      recommendation_id: "rec_create",
      action_type: "draft-listing-create",
      listing_id: null,
      inventory_item_id: "inv_2",
      current_price_amount: null,
      recommended_list_amount: 5,
      quantity_cap: 3,
    });

    const result = await services.applyRecommendations(
      {
        accountId: "acc_1",
        recommendationIds: ["rec_create"],
        marketplaceListings: gateway,
      },
      context,
    );

    expect(result).toEqual({ appliedCount: 1, failedCount: 0 });
    expect(gateway.applyBulkListingPriceUpdates).not.toHaveBeenCalled();
    expect(gateway.createListing).toHaveBeenCalledWith(
      {
        inventoryItemId: "inv_2",
        priceAmount: "5.00",
        quantityCap: 3,
        listingIdOverride: "lst_pricing_rec_create",
      },
      expect.any(Object),
    );
    expect(events.at(-1)?.payload).toMatchObject({
      appliedListingId: "lst_created",
    });
  });

  it("records failed when the bulk listing price update reports a conflict or error outcome", async () => {
    const gateway: PricingMarketplaceListingGateway = {
      applyBulkListingPriceUpdates: vi.fn(async () => ({
        items: [{ listingId: "lst_1", outcome: "error" as const, version: 0, message: "Fee quote changed." }],
      })),
      createListing: vi.fn(async () => ({ id: "lst_created" })),
    };
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [proposedRecommendation],
      }),
    );
    await seedRecommendation(services, proposedRecommendation);

    const result = await services.applyRecommendations(
      {
        accountId: "acc_1",
        recommendationIds: ["rec_active"],
        marketplaceListings: gateway,
      },
      context,
    );

    expect(result).toEqual({ appliedCount: 0, failedCount: 1 });
    // No retry dance -- one bulk call carries the outcome directly.
    expect(gateway.applyBulkListingPriceUpdates).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.eventType).toBe("pricing.recommendation.failed");
    expect(events.at(-1)?.payload).toMatchObject({
      errorMessage: "Fee quote changed.",
    });
  });

  it("hands off lease-loss during apply side effects without recording business failure", async () => {
    const gateway: PricingMarketplaceListingGateway = {
      applyBulkListingPriceUpdates: vi.fn(async () => ({
        items: [{ listingId: "lst_1", outcome: "applied" as const, version: 2 }],
      })),
      createListing: vi.fn(async () => ({ id: "lst_created" })),
    };
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [proposedRecommendation],
      }),
    );
    await seedRecommendation(services, proposedRecommendation);
    const jobContext = {
      throwIfCancelled: vi.fn(),
      renew: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new Error("Pricing recommendation job claim was lost before the status update completed."),
        ),
      checkpointProgress: vi.fn(),
    };

    await expect(
      services.applyRecommendations(
        {
          accountId: "acc_1",
          recommendationIds: ["rec_active"],
          marketplaceListings: gateway,
        },
        context,
        jobContext,
      ),
    ).rejects.toThrow("claim was lost");

    expect(events.map((event) => event.eventType)).not.toContain("pricing.recommendation.failed");
  });

  it("dismisses selected proposed recommendations", async () => {
    const { services, events } = createRuntime(
      queryStub({
        recommendations: [proposedRecommendation],
      }),
    );
    await seedRecommendation(services, proposedRecommendation);

    const result = await services.dismissRecommendations(
      { accountId: "acc_1", recommendationIds: ["rec_active"] },
      context,
    );

    expect(result).toEqual({ dismissedCount: 1 });
    expect(events.at(-1)?.eventType).toBe("pricing.recommendation.dismissed");
  });

  it("returns a command-owned publish snapshot without waiting on the recommendation feed", async () => {
    const staleFeedRecommendation = {
      ...proposedRecommendation,
      recommended_list_amount: 17.99,
      recommendation_reason: "Old guidance.",
    };
    const { services } = createRuntime(
      queryStub({
        recommendations: [staleFeedRecommendation],
      }),
    );
    await seedRecommendation(services, staleFeedRecommendation);

    const snapshot = await services.publishRecommendation(
      {
        recommendationId: "rec_active",
        accountId: "acc_1",
        recommendedListAmount: 16.5,
        reason: "New command-owned guidance.",
        publishedAt: "2026-05-09T01:00:00.000Z",
      },
      context,
    );

    expect(snapshot).toEqual({
      recommendationId: "rec_active",
      accountId: "acc_1",
      status: "proposed",
      recommendedListAmount: 16.5,
      recommendationReason: "New command-owned guidance.",
      publishedAt: "2026-05-09T01:00:00.000Z",
      version: 2,
    });
  });
});
