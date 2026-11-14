import { describe, expect, it, vi } from "vitest";
import { MarketplaceApiError } from "@chase-sets/marketplace/server";
import { createCheckoutSellListRuntime } from "../features/sell-list/api/runtime";
import type {
  CheckoutCommercialTermsResolver,
  CheckoutOfferAcceptanceTermsSource,
  CheckoutSellListLineRow,
  CheckoutSellListTermsPreview,
} from "../features/sell-list/read-model/queries";
import { performMarketplaceHandoff } from "../support/route-support/sell-checkout-session/sell-checkout-handoff";
import {
  SellListReviewPlanStaleError,
  type MarketplaceRequestApiClient,
} from "../support/route-support/sell-checkout-session/sell-checkout-types";

const plainFingerprint = "135.00|6.75|128.25|500|sch_standard|";

const commercialTermsResolver: CheckoutCommercialTermsResolver = {
  resolveListingTerms: async ({ amount }) => ({
    accountType: "personal",
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount: "6.75",
    sellerNetUnitAmount: "128.25",
    shippingAllowancePercentageBps: 500,
    scheduleId: "sch_standard",
    agreementId: null,
    resolvedAt: "2026-11-13T00:00:00.000Z",
  }),
  resolvePublicStandardListingTerms: async () => {
    throw new Error("Standard comparison is not part of this review.");
  },
};

function offerRow(offerId: string, productId: string) {
  return {
    offer_id: offerId,
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_mewtwo",
    product_id: productId,
    item_title: "Mewtwo",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: "135.00",
    price_currency_code: "USD",
    last_stream_version: 2,
    quantity_requested: 1,
    status: "submitted",
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
  };
}

function offerMatchRow(offerId: string, productId: string, listingId: string) {
  return {
    ...offerRow(offerId, productId),
    listing_id: listingId,
    listing_price_amount: "140.00",
    listing_price_currency_code: "USD",
    listing_stream_version: 3,
    listing_quantity_cap: 1,
    listing_visible_quantity: 1,
    offer_price_gap_amount: "5.00",
    offer_to_listing_price_bps: 9643,
    buyer_display_name: "Buyer",
    buyer_average_rating: null,
    buyer_review_count: 0,
    seller_available_quantity: 1,
    seller_listing_availability_status: "available",
  };
}

function sellListLine(overrides: Partial<CheckoutSellListLineRow>): CheckoutSellListLineRow {
  return {
    seller_account_id: "acc_seller",
    line_id: "sll_selected",
    line_type: "selected-offer",
    offer_id: "off_managed",
    listing_id: "lst_seller",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    offer_price_amount: "135.00",
    offer_price_currency_code: "USD",
    offer_stream_version: 2,
    listing_price_amount: "140.00",
    listing_price_currency_code: "USD",
    listing_stream_version: 3,
    catalog_catalog_item_id: "cat_mewtwo",
    product_id: "cat_mewtwo::raw",
    item_title: "Mewtwo",
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    quantity: 1,
    fallback_mode: "none",
    minimum_listing_price_amount: null,
    created_at: "2026-11-13T00:00:00.000Z",
    updated_at: "2026-11-13T00:00:00.000Z",
    ...overrides,
  };
}

const selectedLine = sellListLine({});
const productLine = sellListLine({
  line_id: "sll_product",
  line_type: "product",
  offer_id: null,
  listing_id: null,
  product_id: "cat_mewtwo::graded",
});

/** Answers only the Checkout projections the composite review reads. */
function createCheckoutDb(productMatches = [offerMatchRow("off_product", "cat_mewtwo::graded", "lst_product")]) {
  return {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("FROM checkout_sell_list_line_pages")) return { rows: [selectedLine, productLine] };
      if (sql.includes("offer.product_id = ANY($2::text[])")) return { rows: productMatches };
      if (sql.includes("WHERE offer.offer_id = $2"))
        return { rows: [offerMatchRow("off_managed", "cat_mewtwo::raw", "lst_best_match")] };
      if (sql.includes("FROM checkout_sell_offer_pages") && values[0] === "off_managed")
        return { rows: [offerRow("off_managed", "cat_mewtwo::raw")] };
      return { rows: [] };
    }),
  };
}

/**
 * Stands in for Marketplace's managed-Offer contract: acceptance succeeds only
 * with the fingerprint its acceptance-terms preview returns for the current
 * Offer and Listing versions. The test never builds that value itself.
 * `livePrices` overrides Marketplace's current price for an Offer; Checkout's
 * projection stays at 135.00.
 */
function createManagedMarketplace(livePrices: Readonly<Record<string, string>> = {}) {
  const versions = new Map<string, number>([
    ["off_managed", 2],
    ["off_product", 2],
    ["off_product_next", 2],
  ]);
  const currentFingerprint = (offerId: string, listingId: string) =>
    `managed:${offerId}@${versions.get(offerId)}:${listingId}`;
  const previewOfferAcceptanceTerms = vi.fn<CheckoutOfferAcceptanceTermsSource["previewOfferAcceptanceTerms"]>(
    async ({ offerId, listingId }) =>
      ({
        account_type: "personal",
        basis_amount: livePrices[offerId] ?? "135.00",
        marketplace_sales_fee_unit_amount: "6.75",
        seller_net_unit_amount: "128.25",
        marketplace_sales_fee_percentage_bps: 500,
        shipping_allowance_percentage_bps: 500,
        schedule_id: "sch_standard",
        agreement_id: null,
        resolved_at: "2026-11-13T00:00:00.000Z",
        fee_quote_fingerprint: currentFingerprint(offerId, listingId),
      }) as CheckoutSellListTermsPreview,
  );
  const acceptOfferMatch = vi.fn(async (offerId: string, body: Record<string, unknown>) => {
    if (body.feeQuoteFingerprint !== currentFingerprint(offerId, String(body.listingId))) {
      throw new MarketplaceApiError(409, { error: { code: "fee_quote_stale" } });
    }
    return { offerId, listingId: body.listingId };
  });
  return {
    source: { previewOfferAcceptanceTerms } satisfies CheckoutOfferAcceptanceTermsSource,
    api: { acceptOfferMatch } as unknown as MarketplaceRequestApiClient,
    previewOfferAcceptanceTerms,
    acceptOfferMatch,
    moveOffer(offerId: string) {
      versions.set(offerId, (versions.get(offerId) ?? 0) + 1);
    },
  };
}

async function reviewSellList(
  marketplace: ReturnType<typeof createManagedMarketplace>,
  productMatches?: Parameters<typeof createCheckoutDb>[0],
) {
  const sellList = createCheckoutSellListRuntime({
    eventStore: {} as never,
    checkpointStore: {} as never,
    db: createCheckoutDb(productMatches),
    commercialTermsResolver,
    offerAcceptanceTermsSource: marketplace.source,
  });
  return sellList.loadCompositeReview("acc_seller");
}

function reviewedSelectedOffer(feeQuoteFingerprint: string) {
  return {
    line: selectedLine,
    readinessAction: "selected-offer" as const,
    review: {
      lineId: selectedLine.line_id,
      lineType: "selected-offer" as const,
      itemTitle: selectedLine.item_title,
      productId: selectedLine.product_id,
      quantity: 1,
      selectedOffer: { offerId: "off_managed", listingId: "lst_seller", feeQuoteFingerprint },
      productOfferTargets: [],
      fallbackListing: null,
      skippedReasons: [],
    },
  };
}

describe("Sell List acceptance of a managed Offer", () => {
  it("confirms the acceptance fingerprint Marketplace reports for the reviewed Offer and Listing", async () => {
    const marketplace = createManagedMarketplace();

    const review = await reviewSellList(marketplace);
    const selectedTerms = review.offerReviews[0]?.terms as CheckoutSellListTermsPreview;
    const productOffer = review.productOfferReviews[0]?.offers[0];

    expect(marketplace.previewOfferAcceptanceTerms.mock.calls.map(([params]) => params)).toEqual([
      { offerId: "off_managed", sellerAccountId: "acc_seller", listingId: "lst_seller" },
      { offerId: "off_product", sellerAccountId: "acc_seller", listingId: "lst_product" },
    ]);
    expect(review.offerReviews[0]).toMatchObject({ lineId: "sll_selected", status: "ready" });
    expect(selectedTerms).toEqual({
      account_type: "personal",
      basis_amount: "135.00",
      marketplace_sales_fee_unit_amount: "6.75",
      seller_net_unit_amount: "128.25",
      shipping_allowance_percentage_bps: 500,
      schedule_id: "sch_standard",
      agreement_id: null,
      resolved_at: "2026-11-13T00:00:00.000Z",
      fee_quote_fingerprint: "managed:off_managed@2:lst_seller",
    });
    expect(selectedTerms.fee_quote_fingerprint).not.toBe(plainFingerprint);
    expect(productOffer?.terms.fee_quote_fingerprint).toBe("managed:off_product@2:lst_product");

    const handoff = await performMarketplaceHandoff(marketplace.api, "slc_chk_1", [
      reviewedSelectedOffer(selectedTerms.fee_quote_fingerprint),
      {
        line: productLine,
        readinessAction: "smart-match",
        review: {
          lineId: productLine.line_id,
          lineType: "product",
          itemTitle: productLine.item_title,
          productId: productLine.product_id,
          quantity: 1,
          selectedOffer: null,
          productOfferTargets: [
            {
              offerId: "off_product",
              listingId: "lst_product",
              feeQuoteFingerprint: productOffer!.terms.fee_quote_fingerprint,
              quantity: 1,
            },
          ],
          fallbackListing: null,
          skippedReasons: [],
        },
      },
    ]);

    expect(marketplace.acceptOfferMatch).toHaveBeenCalledWith("off_managed", {
      listingId: "lst_seller",
      feeQuoteFingerprint: "managed:off_managed@2:lst_seller",
      sourceActionKey: "sell-confirm:slc_chk_1:sll_selected:selected:off_managed",
    });
    expect(handoff.summary).toMatchObject({ acceptedOfferCount: 2 });
    expect(handoff.completedLineIds).toEqual(["sll_selected", "sll_product"]);
  });

  it("still refuses as stale when the managed Offer moved after review", async () => {
    const marketplace = createManagedMarketplace();
    const review = await reviewSellList(marketplace);
    const reviewedFingerprint = (review.offerReviews[0]?.terms as CheckoutSellListTermsPreview).fee_quote_fingerprint;

    marketplace.moveOffer("off_managed");

    await expect(
      performMarketplaceHandoff(marketplace.api, "slc_chk_1", [reviewedSelectedOffer(reviewedFingerprint)]),
    ).rejects.toBeInstanceOf(SellListReviewPlanStaleError);
    await expect(marketplace.acceptOfferMatch.mock.results[0]?.value).rejects.toMatchObject({
      status: 409,
      body: { error: { code: "fee_quote_stale" } },
    });
  });

  it("keeps a selected Offer unavailable when Marketplace cannot quote its acceptance", async () => {
    const marketplace = createManagedMarketplace();
    marketplace.previewOfferAcceptanceTerms.mockRejectedValueOnce(new Error("Offer not found."));

    const review = await reviewSellList(marketplace);

    expect(review.offerReviews[0]).toMatchObject({
      lineId: "sll_selected",
      status: "unavailable",
      terms: null,
      message: "Create a matching listing before accepting this offer.",
    });
  });

  it("keeps a selected Offer unavailable when Marketplace prices it differently than the review shows", async () => {
    const marketplace = createManagedMarketplace({ off_managed: "125.00" });

    const review = await reviewSellList(marketplace);

    expect(selectedLine.offer_price_amount).toBe("135.00");
    expect(marketplace.previewOfferAcceptanceTerms).toHaveBeenCalledWith({
      offerId: "off_managed",
      sellerAccountId: "acc_seller",
      listingId: "lst_seller",
    });
    expect(review.offerReviews[0]).toMatchObject({
      lineId: "sll_selected",
      status: "unavailable",
      terms: null,
      message: "Offer price changed. Refresh the Sell List review.",
    });
  });

  it("leaves out a Smart Match candidate that Marketplace prices differently than the review shows", async () => {
    const marketplace = createManagedMarketplace({ off_product: "125.00" });

    const review = await reviewSellList(marketplace, [
      offerMatchRow("off_product", "cat_mewtwo::graded", "lst_product"),
      offerMatchRow("off_product_next", "cat_mewtwo::graded", "lst_product"),
    ]);

    expect(marketplace.previewOfferAcceptanceTerms).toHaveBeenCalledWith({
      offerId: "off_product",
      sellerAccountId: "acc_seller",
      listingId: "lst_product",
    });
    expect(review.productOfferReviews[0]).toMatchObject({ lineId: "sll_product", status: "ready" });
    expect(
      review.productOfferReviews[0]?.offers.map(({ offer, terms }) => [
        offer.offer_id,
        terms.basis_amount,
        terms.fee_quote_fingerprint,
      ]),
    ).toEqual([["off_product_next", "135.00", "managed:off_product_next@2:lst_product"]]);
  });

  it("forwards Marketplace's opaque fingerprint when its price equals the review's in another notation", async () => {
    const marketplace = createManagedMarketplace({ off_managed: "135.0", off_product: "135" });

    const review = await reviewSellList(marketplace);

    expect(review.offerReviews[0]).toMatchObject({
      lineId: "sll_selected",
      status: "ready",
      terms: { basis_amount: "135.0", fee_quote_fingerprint: "managed:off_managed@2:lst_seller" },
    });
    expect(review.productOfferReviews[0]?.offers.map(({ terms }) => terms.fee_quote_fingerprint)).toEqual([
      "managed:off_product@2:lst_product",
    ]);
  });
});
