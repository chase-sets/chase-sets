import { describe, expect, it, vi } from "vitest";
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

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { eventStore };
}

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
