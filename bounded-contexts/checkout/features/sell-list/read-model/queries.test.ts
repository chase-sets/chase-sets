import { describe, expect, it } from "vitest";

import {
  getCheckoutSellOfferMatch,
  getLatestSellListConfirmation,
  getSellPayoutReadiness,
  listSellListLines,
} from "./queries";
import { checkoutOwnerRuntimeFixture, fixtureLine } from "../api/owner-read.fixture";
import { deriveSellListCompositeReview } from "./screen-review";
import { decideCheckoutSellList, initialCheckoutSellListState } from "../domain/domain";
import type {
  CheckoutSellListInventoryItemOption,
  CheckoutSellListProductOfferReview,
  CheckoutSellListRawReview,
} from "./queries";

describe("Sell List screen answers", () => {
  it("returns account and guest screen answers without promoting guest previews to seller authorization", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const account = await f.services.loadCompositeReview("acc_seller");
    expect(account.screen).toMatchObject({
      canContinue: true,
      lineCount: 1,
      totalQuantity: 1,
      selectedOfferGross: "10.00",
      expectedSellerPayout: "10.00",
    });
    expect(account.screen.lines[fixtureLine.line_id]).toMatchObject({
      ready: true,
      canSubmit: true,
      detailCode: "selected-offer-ready",
    });
    const guest = await checkoutOwnerRuntimeFixture("anon_fixture").services.loadGuestCompositeReview("anon_fixture");
    expect(guest).toMatchObject({
      productOfferReviews: [],
      inventoryItems: [],
      screen: { canContinue: false, payoutIsReady: true, payoutReadiness: null },
    });
    expect(guest.offerReviews[0]?.terms).toMatchObject({ source_kind: "public-standard-seller-terms" });
    expect(guest.screen.lines[fixtureLine.line_id]).toMatchObject({
      ready: false,
      canSubmit: false,
      detailCode: "evidence-unavailable",
    });
    expect(await f.services.loadGuestCompositeReview(null)).toMatchObject({
      screen: {
        lineCount: 0,
        canContinue: false,
        selectedOfferGross: "0.00",
        futureListingGross: "0.00",
        estimatedSalesFees: "0.00",
        expectedSellerPayout: "0.00",
      },
    });
  });

  it.each(["pending", "restricted", "not-started"])(
    "gives account payout recovery precedence for %s",
    async (status) => {
      const f = checkoutOwnerRuntimeFixture();
      f.setPayout(status);
      const result = await f.services.loadCompositeReview("acc_seller", { sellListPath: "/account/desk/offers" });
      expect(result.screen).toMatchObject({
        canContinue: false,
        payoutIsReady: false,
        recoveryCode: "set-up-payouts",
        recoveryHref: "/account/payouts/setup?returnTo=%2Faccount%2Fdesk%2Foffers",
      });
    },
  );

  it("preserves missing, stale and incomplete selected Offer reasons and evidence codes", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const review = await f.services.loadCompositeReview("acc_seller");
    const selected = review.offerReviews[0]!;
    const derive = (raw: CheckoutSellListRawReview) =>
      deriveSellListCompositeReview({ lines: [fixtureLine], review: raw, isAccount: false }).screen;
    expect(derive({ ...review, offerReviews: [] }).lines[fixtureLine.line_id]).toMatchObject({
      ready: false,
      labelCode: "needs-refresh",
      detailCode: "offer-terms-need-refresh",
    });
    expect(
      derive({
        ...review,
        offerReviews: [{ ...selected, status: "unavailable", terms: null, message: "Offer changed." }],
      }),
    ).toMatchObject({
      expectedSellerPayout: null,
      estimatedSalesFees: null,
      lines: { [fixtureLine.line_id]: { message: "Offer changed.", canSubmit: false } },
    });
    expect(
      derive({
        ...review,
        offerReviews: [
          {
            ...selected,
            evidence: {
              ...selected.evidence!,
              coverage: { ...selected.evidence!.coverage, complete: false, unmetCodes: ["min-photo-count-unmet"] },
            },
          },
        ],
      }).lines[fixtureLine.line_id],
    ).toMatchObject({
      detailCode: "evidence-incomplete",
      unmetEvidenceCodes: ["min-photo-count-unmet"],
      ready: false,
      canSubmit: false,
    });
    f.setOfferStreamVersion(2);
    expect((await f.services.loadCompositeReview("acc_seller")).screen.lines[fixtureLine.line_id]).toMatchObject({
      ready: false,
      canSubmit: false,
      labelCode: "needs-refresh",
    });
  });

  it.each([0, 1, 3])("returns exact decimal totals at selected quantity %i", async (quantity) => {
    const f = checkoutOwnerRuntimeFixture();
    const review = await f.services.loadCompositeReview("acc_seller");
    const selected = review.offerReviews[0]!;
    const lines = [
      { ...fixtureLine, quantity, offer_price_amount: "0.10" },
      { ...fixtureLine, line_id: "sll_second", quantity: 1, offer_price_amount: "0.20" },
    ];
    const result = deriveSellListCompositeReview({
      lines,
      isAccount: false,
      review: {
        ...review,
        offerReviews: lines.map((line) => ({
          ...selected,
          lineId: line.line_id,
          terms: {
            ...selected.terms!,
            seller_net_unit_amount: line.offer_price_amount!,
            marketplace_sales_fee_unit_amount: "0.10",
          },
        })),
      },
    });
    expect(result.screen.selectedOfferGross).toBe(["0.20", "0.30", "0.50"][quantity === 3 ? 2 : quantity]);
    expect(result.screen.expectedSellerPayout).toBe(result.screen.selectedOfferGross);
    expect(result.screen.estimatedSalesFees).toBe(quantity === 0 ? "0.10" : quantity === 1 ? "0.20" : "0.40");
  });

  it("uses matched quantities for Smart Match and only a non-negative create-listing remainder", async () => {
    const f = checkoutOwnerRuntimeFixture();
    const review = await f.services.loadCompositeReview("acc_seller");
    const selected = review.offerReviews[0]!;
    const productLine = {
      ...fixtureLine,
      line_id: "sll_product",
      line_type: "product" as const,
      quantity: 5,
      fallback_mode: "create-listing" as const,
      minimum_listing_price_amount: "0.10",
    };
    const match = {
      offer: { quantity_requested: 2 },
      terms: { seller_net_unit_amount: "0.10", marketplace_sales_fee_unit_amount: "0.20" },
      evidence: selected.evidence,
    } as CheckoutSellListProductOfferReview["offers"][number];
    const derive = (
      quantity: number,
      offers: CheckoutSellListProductOfferReview["offers"],
      fallback_mode = productLine.fallback_mode,
    ) =>
      deriveSellListCompositeReview({
        lines: [fixtureLine, { ...productLine, quantity, fallback_mode }],
        review: {
          ...review,
          productOfferReviews: [{ lineId: productLine.line_id, status: "ready", offers, message: null }],
        },
        isAccount: false,
      }).screen;
    expect(derive(5, [match, { ...match, offer: { ...match.offer, quantity_requested: 1 } }])).toMatchObject({
      selectedOfferGross: "10.00",
      futureListingGross: "0.20",
      expectedSellerPayout: "10.30",
      estimatedSalesFees: "0.60",
      hasMultipleOffers: true,
      readyLineCount: 2,
      canContinue: true,
    });
    expect(derive(1, [match])).toMatchObject({ futureListingGross: "0.00", hasMultipleOffers: false });
    expect(derive(5, [])).toMatchObject({
      expectedSellerPayout: null,
      estimatedSalesFees: null,
      futureListingGross: "0.50",
      blockedLineCount: 1,
    });
    expect(derive(5, [{ ...match, evidence: null }]).lines[productLine.line_id]).toMatchObject({
      ready: false,
      canSubmit: false,
      detailCode: "evidence-unavailable",
    });
  });

  it("keeps inventory-only product submission and setup targets without inventing quotes", () => {
    const line = { ...fixtureLine, line_type: "product" as const, fallback_mode: "none" as const };
    const inventory = { item_id: "inv_fixture", product_id: line.product_id } as CheckoutSellListInventoryItemOption;
    const result = deriveSellListCompositeReview({
      lines: [line],
      isAccount: false,
      review: { offerReviews: [], productOfferReviews: [], inventoryItems: [inventory] },
    });
    expect(result.screen).toMatchObject({
      canContinue: true,
      expectedSellerPayout: null,
      estimatedSalesFees: null,
      futureListingGross: "0.00",
    });
    expect(result.screen.lines[line.line_id]).toMatchObject({
      ready: true,
      canSubmit: true,
      detailCode: "fallback-listing-form-ready",
      setupHref: "/account/listings/new?inventoryItemId=inv_fixture",
    });
  });

  it.each([
    ["none", "0.00"],
    ["create-listing", "0.10"],
  ] as const)("reads accepted decimal prices with %s fallback", (fallbackMode, futureListingGross) => {
    const events = decideCheckoutSellList(initialCheckoutSellListState, {
      type: "AddSellListLine",
      sellerAccountId: fixtureLine.seller_account_id as never,
      lineId: fixtureLine.line_id as never,
      lineType: "product",
      offerId: null,
      listingId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: fixtureLine.catalog_catalog_item_id,
      productId: fixtureLine.product_id,
      itemTitle: fixtureLine.item_title,
      itemSubtitle: null,
      productSummary: null,
      selectedOptions: [],
      quantity: 1,
      fallbackMode,
      minimumListingPriceAmount: "0.100",
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    if (event.type !== "checkout.sell-list.line-added") throw new Error("Expected accepted product line.");
    const line = {
      ...fixtureLine,
      line_type: event.data.lineType,
      quantity: event.data.quantity,
      fallback_mode: event.data.fallbackMode,
      minimum_listing_price_amount: event.data.minimumListingPriceAmount,
    };
    const result = deriveSellListCompositeReview({
      lines: [line],
      isAccount: false,
      review: { offerReviews: [], productOfferReviews: [], inventoryItems: [] },
    });
    expect(result.screen).toMatchObject({ futureListingGross, expectedSellerPayout: null, estimatedSalesFees: null });
    expect(result.screen.lines[line.line_id]?.setupHref).toContain("recommendedPrice=0.10");
  });

  it.each(["0.001", "not-a-price", "9999999999.9901", "10000000000.00"])(
    "returns a non-authoritative line for unusable contributing price %s without aborting siblings",
    (price) => {
      const line = {
        ...fixtureLine,
        line_type: "product" as const,
        fallback_mode: "create-listing" as const,
        minimum_listing_price_amount: price,
      };
      const inventory = { item_id: "inv_fixture", product_id: line.product_id } as CheckoutSellListInventoryItemOption;
      const review = { offerReviews: [], productOfferReviews: [], inventoryItems: [inventory] };
      const result = deriveSellListCompositeReview({
        lines: [line, { ...line, line_id: "sll_valid", minimum_listing_price_amount: "0.100" }],
        isAccount: false,
        review,
      });
      expect(result.screen).toMatchObject({
        canContinue: false,
        futureListingGross: "0.10",
        expectedSellerPayout: null,
        estimatedSalesFees: null,
        lines: {
          [line.line_id]: { ready: false, canSubmit: false, detailCode: "choose-sale-action" },
          sll_valid: { ready: true, canSubmit: true, detailCode: "fallback-listing-ready" },
        },
      });
      expect(
        deriveSellListCompositeReview({ lines: [{ ...line, fallback_mode: "none" }], isAccount: false, review }).screen,
      ).toMatchObject({ canContinue: true, futureListingGross: "0.00" });
    },
  );

  it.each([
    { amounts: ["9999999999.99"], quantity: 1, total: "9999999999.99" },
    { amounts: ["100.00"], quantity: 100000000, total: "10000000000.00" },
    { amounts: ["9999999999.99", "0.01"], quantity: 1, total: "10000000000.00" },
  ])(
    "serializes all aggregate cents exactly: $total from $amounts at $quantity",
    async ({ amounts, quantity, total }) => {
      const f = checkoutOwnerRuntimeFixture();
      const review = await f.services.loadCompositeReview("acc_seller");
      const selected = review.offerReviews[0]!;
      const lines = amounts.map((amount, index) => ({
        ...fixtureLine,
        line_id: `sll_boundary_${index}`,
        quantity,
        offer_price_amount: amount,
        minimum_listing_price_amount: amount,
        fallback_mode: "create-listing" as const,
      }));
      const result = deriveSellListCompositeReview({
        lines,
        isAccount: false,
        review: {
          ...review,
          offerReviews: lines.map((line) => ({
            ...selected,
            lineId: line.line_id,
            terms: {
              ...selected.terms!,
              seller_net_unit_amount: line.offer_price_amount,
              marketplace_sales_fee_unit_amount: line.offer_price_amount,
            },
          })),
        },
      });
      expect(result.screen).toMatchObject({
        selectedOfferGross: total,
        expectedSellerPayout: total,
        estimatedSalesFees: total,
      });
      expect(
        deriveSellListCompositeReview({
          lines: lines.map((line) => ({ ...line, line_type: "product" })),
          isAccount: false,
          review: { offerReviews: [], productOfferReviews: [], inventoryItems: [] },
        }).screen,
      ).toMatchObject({ futureListingGross: total, expectedSellerPayout: null, estimatedSalesFees: null });
    },
  );
});

describe("sell list confirmation queries", () => {
  it.each([1, "1", "2"])("compares normalized selected Offer and line versions: %s", async (version) => {
    const f = checkoutOwnerRuntimeFixture();
    f.setLines([{ ...fixtureLine, offer_stream_version: "1" as never, listing_stream_version: "1" as never }]);
    f.setOfferStreamVersion(version);
    const review = await f.services.loadCompositeReview("acc_seller");
    expect(review.offerReviews).toEqual([
      expect.objectContaining({ status: version === "2" ? "unavailable" : "ready" }),
    ]);
  });
  it.each(["bad", "9007199254740992"])("refuses malformed or unsafe Offer page versions: %s", async (version) => {
    const f = checkoutOwnerRuntimeFixture();
    f.setOfferStreamVersion(version);
    await expect(f.services.loadCompositeReview("acc_seller")).rejects.toThrow("Invalid Sell List stream version.");
  });
  it.each([null, 1, "1", "9007199254740991"])("normalizes nullable safe stream versions: %s", async (version) => {
    const db = {
      query: async () => ({
        rows: [{ ...fixtureLine, offer_stream_version: version, listing_stream_version: version }],
      }),
    };
    const [line] = await listSellListLines(db, "acc_seller");
    expect(line).toMatchObject({
      offer_stream_version: version === null ? null : Number(version),
      listing_stream_version: version === null ? null : Number(version),
    });
  });
  it.each(["9007199254740992", "bad", "", "1.5", "-1", 0])(
    "refuses malformed or unsafe stream versions: %s",
    async (version) => {
      for (const column of ["offer_stream_version", "listing_stream_version"]) {
        const db = { query: async () => ({ rows: [{ ...fixtureLine, [column]: version }] }) };
        await expect(listSellListLines(db, "acc_seller")).rejects.toThrow("Invalid Sell List stream version.");
      }
    },
  );
  it("uses the Checkout offer page stream fence for Sell List Matches", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getCheckoutSellOfferMatch(db, "acc_seller", "off_1")).resolves.toBeNull();
    expect(queriedSql[0]).toContain("offer.last_stream_version > 0");
    expect(queriedSql[0]).not.toContain("offer.offer_stream_version > 0");
  });

  it("reads only fresh confirmation pages", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return {
          rows: [
            {
              seller_account_id: "acc_seller",
              confirmation_id: "slc_1",
              confirmed_at: "2026-06-09T00:00:00.000Z",
              readiness_evidence: { snapshotId: "slr_ready" },
              seller_evidence: { shipFrom: { status: "ready" } },
              handoff_summary: { acceptedOfferCount: 1 },
            },
          ],
        };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toEqual({
      seller_account_id: "acc_seller",
      confirmation_id: "slc_1",
      confirmed_at: "2026-06-09T00:00:00.000Z",
      readiness_evidence: { snapshotId: "slr_ready" },
      seller_evidence: { shipFrom: { status: "ready" } },
      handoff_summary: { acceptedOfferCount: 1 },
    });
    expect(queriedSql.join("\n")).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql.join("\n")).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("does not query old receipt tables when no confirmation exists", async () => {
    const queriedSql: string[] = [];
    const db = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        return { rows: [] };
      },
    };

    await expect(getLatestSellListConfirmation(db, "acc_seller")).resolves.toBeNull();
    expect(queriedSql).toHaveLength(1);
    expect(queriedSql[0]).toContain("checkout_sell_list_confirmation_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_execution_pages");
    expect(queriedSql[0]).not.toContain("checkout_sell_list_receipt_pages");
  });

  it("reads Checkout-owned sell payout readiness rows", async () => {
    const db = {
      query: async () => ({
        rows: [
          {
            account_id: "acc_seller",
            status: "restricted",
            missing_requirements: ["external_account"],
            updated_at: "2026-06-09T00:00:00.000Z",
          },
        ],
      }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "restricted",
      missing_requirements: ["external_account"],
      updated_at: "2026-06-09T00:00:00.000Z",
    });
  });

  it("returns setup-required payout readiness when no local row exists yet", async () => {
    const db = {
      query: async () => ({ rows: [] }),
    };

    await expect(getSellPayoutReadiness(db, "acc_seller")).resolves.toEqual({
      account_id: "acc_seller",
      status: "not-started",
      missing_requirements: ["provider-onboarding", "seller-agreement"],
      updated_at: null,
    });
  });
});
