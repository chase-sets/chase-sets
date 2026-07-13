import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createMarketplaceOfferRuntime } from "./runtime";
import { MarketplaceOfferAbuseControlError } from "../domain/offer-abuse-policy";

const acceptedOfferMatch = {
  offer_id: "off_1",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  shipping_destination_snapshot: {
    name: "Buyer",
    line1: "1 Main",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  price_amount: "350.00",
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-03-31T00:00:00.000Z",
  updated_at: "2026-03-31T00:00:00.000Z",
  listing_id: "lst_1",
  listing_price_amount: "375.00",
  listing_quantity_cap: 1,
  listing_visible_quantity: 1,
  offer_price_gap_amount: "25.00",
  offer_to_listing_price_bps: 9333,
  buyer_display_name: "Collector Account",
  seller_available_quantity: 1,
  seller_listing_availability_status: "available",
};

describe("marketplace offer runtime", () => {
  function createSubmitOfferServices(db: { query: ReturnType<typeof vi.fn> }) {
    const { eventStore } = createInMemoryEventStore();
    return createMarketplaceOfferRuntime({
      db: db as never,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });
  }

  function activeCatalogItem() {
    return {
      catalog_item_id: "cat_charizard",
      title: "Charizard",
      subtitle: null,
      status: "active",
      product_schema: null,
    };
  }

  function activeListingGuard(overrides: Record<string, unknown> = {}) {
    return {
      listing_id: "lst_1",
      seller_account_id: "acc_seller",
      listing_price_amount: "100.00",
      buyer_listing_daily_offer_count: "0",
      muted_at: null,
      lowball_cooldown_until: null,
      last_lowball_declined_amount: null,
      ...overrides,
    };
  }

  async function submitOfferWithDb(db: { query: ReturnType<typeof vi.fn> }, priceAmount = "80.00") {
    return createSubmitOfferServices(db).submitOffer(
      {
        buyerAccountId: "acc_buyer" as never,
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount,
        quantityRequested: 1,
      },
      {
        tenantId: "tnt_marketplace" as never,
        audit: {
          performedByUserId: "usr_buyer" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    );
  }

  it("enforces buyer daily submission caps before submitting an offer", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "25" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard()] }),
    };

    await expect(submitOfferWithDb(db)).rejects.toMatchObject({
      code: "offer_daily_submission_cap_reached",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it("enforces per-listing buyer cap boundaries before submitting an offer", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard({ buyer_listing_daily_offer_count: "3" })] }),
    };

    await expect(submitOfferWithDb(db)).rejects.toMatchObject({
      code: "offer_listing_submission_cap_reached",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it("rejects offer submissions below the listing-relative price floor", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard()] }),
    };

    await expect(submitOfferWithDb(db, "49.99")).rejects.toMatchObject({
      code: "offer_price_floor_not_met",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it("rejects lower repeated-lowball offers during the seller cooldown window", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({
          rows: [
            activeListingGuard({
              lowball_cooldown_until: "2099-01-01T00:00:00.000Z",
              last_lowball_declined_amount: "90.00",
            }),
          ],
        }),
    };

    await expect(submitOfferWithDb(db, "80.00")).rejects.toMatchObject({
      code: "offer_lowball_cooldown",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it("rejects offer submissions when every current matching seller muted the buyer", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard({ muted_at: "2026-07-05T12:00:00.000Z" })] }),
    };

    await expect(submitOfferWithDb(db, "80.00")).rejects.toMatchObject({
      code: "offer_muted_by_sellers",
    } satisfies Partial<MarketplaceOfferAbuseControlError>);
  });

  it("allows an offer at the cap and floor boundary", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [activeCatalogItem()] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: "24" }] })
        .mockResolvedValueOnce({ rows: [activeListingGuard({ buyer_listing_daily_offer_count: "2" })] }),
    };

    await expect(submitOfferWithDb(db, "50.00")).resolves.toMatchObject({ offerId: expect.any(String) });
  });

  it("records seller decline and mute controls for an offer match", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })),
    };
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: {
        performedByUserId: "usr_seller" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await expect(
      services.declineOfferMatch(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({ offerId: "off_1", version: 1 });
    await expect(
      services.muteBuyerOffers(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({ offerId: "off_1", version: 2 });
    await expect(
      services.unmuteBuyerOffers(
        {
          listingId: "lst_1",
          buyerAccountId: "acc_buyer" as never,
          sellerAccountId: "acc_seller" as never,
        },
        context,
      ),
    ).resolves.toEqual({ listingId: "lst_1", buyerAccountId: "acc_buyer", version: 3 });
  });

  it("keeps offer acceptance gated by matching active supply", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            offer_id: "off_1",
            buyer_account_id: "acc_buyer",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            shipping_destination_snapshot: {},
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            accepted_seller_account_id: null,
            accepted_at: null,
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
            listing_id: "lst_1",
            listing_price_amount: "375.00",
            listing_quantity_cap: 1,
            listing_visible_quantity: 0,
            offer_price_gap_amount: "25.00",
            offer_to_listing_price_bps: 9333,
            buyer_display_name: "Collector Account",
            seller_available_quantity: 0,
            seller_listing_availability_status: "available",
          },
        ],
      })),
    };
    const commercialTermsResolver = vi.fn(async () => {
      throw new Error("Terms should not be quoted when supply is missing.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore: {
        appendToStream: vi.fn(async () => []),
        readStream: vi.fn(async () => []),
        readAll: vi.fn(async () => []),
      } satisfies EventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: commercialTermsResolver as never,
    });

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_seller" as never,
          feeQuoteFingerprint: "quote",
        },
        {} as never,
      ),
    ).rejects.toThrow("Seller does not have enough active supply to accept this offer.");
    expect(commercialTermsResolver).not.toHaveBeenCalled();
  });

  it("rejects same-account offer acceptance before quoting terms", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [{ ...acceptedOfferMatch, buyer_account_id: "acc_same" }] })),
    };
    const resolveListingTerms = vi.fn(async () => {
      throw new Error("Terms should not be quoted for self-dealing.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
    });

    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1",
        buyerAccountId: "acc_same",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        quantityRequested: 1,
      },
      context: {
        tenantId: "tnt_marketplace" as never,
        audit: {
          performedByUserId: "usr_same" as never,
          forAccountId: "acc_same" as never,
        },
      },
    } as never);

    await expect(
      services.acceptOffer(
        {
          offerId: "off_1" as never,
          sellerAccountId: "acc_same" as never,
          feeQuoteFingerprint: "quote",
        },
        {} as never,
      ),
    ).rejects.toThrow("Accounts cannot accept their own offers.");
    expect(resolveListingTerms).not.toHaveBeenCalled();
  });

  it("rejects offer submission when the buyer has an active listing for the product", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              catalog_item_id: "cat_charizard",
              title: "Charizard",
              subtitle: null,
              status: "active",
              product_schema: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ account_id: "acc_same" }] }),
    };
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore: {
        appendToStream: vi.fn(async () => []),
        readStream: vi.fn(async () => []),
        readAll: vi.fn(async () => []),
      } satisfies EventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: {} as never,
    });

    await expect(
      services.submitOffer(
        {
          buyerAccountId: "acc_same" as never,
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
          priceAmount: "350.00",
          quantityRequested: 1,
        },
        {} as never,
      ),
    ).rejects.toThrow("Accounts cannot offer on their own listings.");
  });

  it("treats repeated acceptance by the same seller as an idempotent retry", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [acceptedOfferMatch] })),
    };
    const resolveListingTerms = vi.fn(async () => ({
      accountType: "personal",
      basisAmount: "350.00",
      marketplaceSalesFeeUnitAmount: "17.50",
      sellerNetUnitAmount: "332.50",
      shippingAllowancePercentageBps: 500,
      scheduleId: "sch_standard",
      agreementId: null,
      resolvedAt: "2026-03-31T00:00:00.000Z",
    }));
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore,
      checkpointStore: {} as never,
      commercialTermsResolver: { resolveListingTerms } as never,
    });
    const context = {
      tenantId: "tnt_marketplace" as never,
      audit: {
        performedByUserId: "usr_seller" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "marketplace.offer-off_1",
      command: {
        type: "SubmitOffer",
        offerId: "off_1",
        buyerAccountId: "acc_buyer",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: acceptedOfferMatch.shipping_destination_snapshot,
        priceAmount: "350.00",
        quantityRequested: 1,
      },
      context,
    } as never);

    const first = await services.acceptOffer(
      {
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      context,
    );
    vi.mocked(db.query).mockResolvedValue({ rows: [] });
    const retry = await services.acceptOffer(
      {
        offerId: "off_1" as never,
        sellerAccountId: "acc_seller" as never,
        feeQuoteFingerprint: "350.00|17.50|332.50|500|sch_standard|",
      },
      context,
    );

    expect(first).toEqual({ offerId: "off_1", version: 2 });
    expect(retry).toEqual({ offerId: "off_1", version: 2 });
    expect(resolveListingTerms).toHaveBeenCalledTimes(1);
  });
});
