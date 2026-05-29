import { describe, expect, it, vi } from "vitest";
import { createMarketplaceOfferRuntime } from "./runtime";

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
            in_sell_list: false,
          },
        ],
      })),
    };
    const commercialTermsResolver = vi.fn(async () => {
      throw new Error("Terms should not be quoted when supply is missing.");
    });
    const services = createMarketplaceOfferRuntime({
      db,
      eventStore: {} as never,
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
});
