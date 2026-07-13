// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutSellListPage } from "./sell-list-page";
import type { CheckoutSellListConfirmationRow, CheckoutSellListLineRow } from "../read-model/queries";

afterEach(async () => {
  cleanup();
  // Drain React scheduler work from dialog interactions before jsdom teardown.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

const selectedOfferLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_offer",
  line_type: "selected-offer",
  offer_id: "off_charizard",
  listing_id: "lst_charizard",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Ash Ketchum",
  offer_price_amount: "350.00",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Raw / Near Mint",
  quantity: 2,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const productLine: CheckoutSellListLineRow = {
  ...selectedOfferLine,
  line_id: "sll_product",
  line_type: "product",
  offer_id: null,
  listing_id: null,
  buyer_account_id: null,
  buyer_display_name: null,
  offer_price_amount: null,
  quantity: 1,
  fallback_mode: "create-listing",
  minimum_listing_price_amount: "399.00",
};

const latestConfirmation: CheckoutSellListConfirmationRow = {
  seller_account_id: "acc_seller",
  confirmation_id: "slc_chk_sell_1",
  confirmed_at: "2026-06-11T05:00:00.000Z",
  readiness_evidence: {
    contract: "checkout.sell-list-readiness.v1",
    sourceRevision: "sell-list-rev-1",
  },
  seller_evidence: {
    sellerAccountId: "acc_seller",
    payoutReadiness: "ready",
  },
  handoff_summary: {
    acceptedOfferCount: 1,
    publishedListingCount: 1,
    skippedLineCount: 0,
    skippedReasons: [],
    sideEffects: {
      sale: "handoff-recorded",
      accountHistory: "pending-downstream",
      label: "pending-downstream",
      payout: "pending-downstream",
      settlement: "pending-downstream",
      notification: "pending-downstream",
    },
    lineOutcomes: [
      {
        lineId: "sll_offer",
        itemTitle: "Charizard",
        status: "completed",
        action: "mixed",
        quantity: 2,
        remainingQuantity: 0,
        detail: "Sale review saved. Labels, payout, and updates are still pending.",
        references: {
          offerIds: ["off_charizard"],
          listingId: "lst_charizard",
        },
      },
    ],
  },
};

describe("checkout sell list page", () => {
  it("renders a simple seller review with readiness and payout before checkout", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine, productLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "35.00",
              seller_net_unit_amount: "315.00",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "fee_selected",
            },
            comparison: null,
            message: null,
          },
        ]}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "ready",
            offers: [
              {
                offer: {
                  offer_id: "off_blastoise",
                  buyer_display_name: "Misty",
                  buyer_account_id: "acc_misty",
                  price_amount: "410.00",
                  quantity_requested: 1,
                  offer_to_listing_price_bps: 10200,
                  can_fulfill: true,
                },
                terms: {
                  marketplace_sales_fee_unit_amount: "41.00",
                  seller_net_unit_amount: "369.00",
                  fee_quote_fingerprint: "fee_product",
                },
              },
            ],
            message: null,
          },
        ]}
        inventoryItems={[
          {
            item_id: "inv_blastoise",
            product_id: productLine.product_id,
            item_title: "Blastoise",
            product_summary: "Raw / Near Mint",
            storage_location_name: "Home Vault",
            ship_from_code: "KS",
            available_quantity: 1,
          },
        ]}
      />,
    );

    expect(markup).toContain("Sell List");
    expect(markup).toContain("Review cards, payout readiness, and pre-checkout sale actions before seller checkout.");
    expect(markup).toContain("Ready for seller checkout");
    expect(markup).toContain("Review items");
    expect(markup).toContain("Selected offer");
    expect(markup).toContain("Product");
    expect(markup).toContain("Ash Ketchum");
    expect(markup).toContain("Use Misty offer");
    expect(markup).toContain("Expected seller payout");
    expect(markup).toContain("$999.00");
    expect(markup).toContain("Payout readiness");
    expect(markup).toContain("Line readiness");
    expect(markup).toContain("Continue to seller checkout");
    expect(markup).toContain('id="sell-list-checkout-form"');
    expect(markup).toContain('name="offerFeeQuoteFingerprint:sll_offer"');
    expect(markup).toContain('name="productOfferFeeQuoteFingerprint:sll_product:off_blastoise"');
    expect(markup).not.toContain("Execute sale checkout");
    expect(markup).not.toContain("Smart Match settings");
    expect(markup).not.toContain("Checkout owns the review step");
    expect(markup).not.toContain(">Execution<");
  });

  it("keeps selected-offer and product facts out of the narrow action column", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine, productLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "35.00",
              seller_net_unit_amount: "315.00",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "fee_selected",
            },
            comparison: null,
            message: null,
          },
        ]}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "ready",
            offers: [
              {
                offer: {
                  offer_id: "off_blastoise",
                  buyer_display_name: "Misty",
                  buyer_account_id: "acc_misty",
                  price_amount: "410.00",
                  quantity_requested: 1,
                  offer_to_listing_price_bps: 10200,
                  can_fulfill: true,
                },
                terms: {
                  marketplace_sales_fee_unit_amount: "41.00",
                  seller_net_unit_amount: "369.00",
                  fee_quote_fingerprint: "fee_product",
                },
              },
            ],
            message: null,
          },
        ]}
        inventoryItems={[
          {
            item_id: "inv_blastoise",
            product_id: productLine.product_id,
            item_title: "Blastoise",
            product_summary: "Raw / Near Mint",
            storage_location_name: "Kansas City Fulfillment Locker",
            ship_from_code: "KS",
            available_quantity: 1,
          },
        ]}
      />,
    );

    const readableRowTemplates = markup.match(/--grid-template-columns-md:minmax\(0,1fr\) auto/g) ?? [];
    expect(readableRowTemplates.length).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain("minmax(11rem,14rem)");
    expect(markup).toContain("Matching offers");
    expect(markup).toContain("Kansas City Fulfillment Locker / KS (1)");
  });

  it("blocks seller checkout when payout or line readiness is unresolved", () => {
    const blockedProductLine: CheckoutSellListLineRow = {
      ...productLine,
      fallback_mode: "none",
      minimum_listing_price_amount: null,
    };

    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[blockedProductLine]}
        payoutReadiness={{ status: "restricted", missing_requirements: ["bank account"] }}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "unavailable",
            offers: [],
            message: "No ready matching offers are currently available.",
          },
        ]}
      />,
    );

    expect(markup).toContain("Some items need action");
    expect(markup).toContain("Resolve 1 line(s) before seller checkout starts.");
    expect(markup).toContain("Payout setup required");
    expect(markup).toContain("bank account");
    expect(markup).toContain("No ready Smart Match offers are available for this line.");
    expect(markup).toContain("Set up payouts");
    expect(markup).toContain('href="/account/payouts/setup?returnTo=%2Faccount%2Fsell-list"');
    expect(markup).toContain("Create listing");
    expect(markup).toContain("Add inventory");
    expect(markup).toContain('href="/account/listings/new?catalogItemId=cat_charizard');
    expect(markup).toContain('href="/account/inventory?catalogItemId=cat_charizard');
    expect(markup).toContain("returnTo=%2Faccount%2Fsell-list");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Continue sale checkout to safely resume");
    expect(markup).not.toContain("provider diagnostics");
    expect(markup).not.toContain("settlement internals");
  });

  it("surfaces evaluator coverage and blocks selected-offer checkout until evidence is complete", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "35.00",
              seller_net_unit_amount: "315.00",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "fee_selected",
            },
            comparison: null,
            message: null,
            evidence: {
              listingId: "lst_charizard",
              listingStatus: "active",
              evidence: [],
              policyHash: "sha256:policy",
              policyVersion: 1,
              requirements: {
                minimumPhotoCount: 1,
                requiredSlots: [
                  {
                    slotId: "condition",
                    viewKind: "condition",
                    minimumWidthPixels: null,
                    minimumHeightPixels: null,
                    maximumAgeHours: null,
                  },
                ],
                sellerTrustRequirements: [],
                buyerAcknowledgment: "none",
              },
              coverage: {
                complete: false,
                unmetCodes: ["slot-missing", "min-photo-count-unmet"],
                slots: [
                  {
                    slotId: "condition",
                    viewKind: "condition",
                    satisfied: false,
                    matchedPhotoId: null,
                    unmetCode: "slot-missing",
                  },
                ],
                activePhotoCount: 0,
                minimumPhotoCount: 1,
              },
              updatedAt: "2026-07-13T00:00:00.000Z",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Evidence needs action");
    expect(markup).toContain("Required listing evidence");
    expect(markup).toContain("lst_charizard");
    expect(markup).toContain("Add the required photo for this view.");
    expect(markup).toContain('name="listingPhoto"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain('Continue to seller checkout">Continue to seller checkout</button>');
  });

  it("lets a product line submit fallback listing checkout when inventory is available", () => {
    const productWithoutMatches: CheckoutSellListLineRow = {
      ...productLine,
      fallback_mode: "none",
      minimum_listing_price_amount: null,
    };

    const { container } = render(
      <CheckoutSellListPage
        sellListLines={[productWithoutMatches]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        productOfferReviews={[
          {
            lineId: "sll_product",
            status: "unavailable",
            offers: [],
            message: "No ready matching offers are currently available.",
          },
        ]}
        inventoryItems={[
          {
            item_id: "inv_charizard",
            product_id: productLine.product_id,
            item_title: "Charizard",
            product_summary: "Raw / Near Mint",
            storage_location_name: "Home Vault",
            ship_from_code: "KS",
            available_quantity: 1,
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Inventory is ready. Enter a listing price before continuing seller checkout."),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Continue to seller checkout" })[0]?.hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      (container.querySelector('select[name="fallbackMode:sll_product"]') as HTMLSelectElement | null)?.value,
    ).toBe("create-listing");
    expect(
      (container.querySelector('select[name="inventoryItemId:sll_product"]') as HTMLSelectElement | null)?.value,
    ).toBe("inv_charizard");
    expect(
      (container.querySelector('input[name="priceAmount:sll_product"]') as HTMLInputElement | null)?.required,
    ).toBe(true);
  });

  it("links unavailable selected offers to matching listing setup", () => {
    render(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "unavailable",
            terms: null,
            comparison: null,
            message: "Offer not found.",
          },
        ]}
      />,
    );

    const setupLink = screen.getByRole("link", { name: "Create matching listing" });
    expect(setupLink.getAttribute("href")).toBe(
      "/account/listings/new?catalogItemId=cat_charizard&recommendedPrice=350.00&selectedOptions=%5B%7B%22dimensionId%22%3A%22condition%22%2C%22optionId%22%3A%22raw%22%7D%5D",
    );
    expect(screen.getAllByRole("link", { name: "Resolve items" })[0]?.getAttribute("href")).toBe(
      setupLink.getAttribute("href"),
    );
  });

  it("shows a simple empty Sell List recovery state", () => {
    const markup = renderToString(<CheckoutSellListPage sellListLines={[]} />);

    expect(markup).toContain("Your Sell List is empty");
    expect(markup).toContain("Add selected offers or products");
    expect(markup).toContain("Browse products");
    expect(markup).not.toContain("Expected seller payout");
    expect(markup).not.toContain("Continue to seller checkout");
  });

  it("shows pending fresh-write recovery instead of the normal empty Sell List state", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[]}
        recoveryState={{
          kind: "pending-fresh-write",
          message: "Your Sell List is updating.",
          refreshHref: "/account/sell-list?afterWrite=receipt",
          isAutoRevalidating: true,
        }}
      />,
    );

    expect(markup).toContain("Updating Sell List");
    expect(markup).toContain("Your Sell List is catching up");
    expect(markup).toContain("Your Sell List is updating.");
    expect(markup).toContain("Refresh Sell List");
    expect(markup).toContain('href="/account/sell-list?afterWrite=receipt"');
    expect(markup).not.toContain("Your Sell List is empty");
    expect(markup).not.toContain("Browse products");
  });

  it("shows an actionable expired fresh-write recovery when the added line stays missing", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[]}
        recoveryState={{
          kind: "missing-after-fresh-write",
          message: "We saved the Sell List request, but the new line is still not visible.",
          refreshHref: "/account/sell-list",
        }}
      />,
    );

    expect(markup).toContain("Sell List line not visible yet");
    expect(markup).toContain("We saved the Sell List request");
    expect(markup).toContain("Refresh Sell List");
    expect(markup).toContain('href="/account/sell-list"');
    expect(markup).toContain("Browse products");
    expect(markup).not.toContain("Your Sell List is catching up");
    expect(markup).not.toContain("Your Sell List is empty");
  });

  it("shows a signed-in registration return notice after anonymous Sell List merge", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        registrationReturn="seller-checkout"
        mergedLineCount={1}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "35.00",
              seller_net_unit_amount: "315.00",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "registered_quote",
            },
            comparison: null,
            message: null,
          },
        ]}
      />,
    );

    expect(markup).toContain("Sell List saved to your account");
    expect(markup).toContain(
      "1 Sell List line(s) moved to your account. Review final seller terms, payout setup, and ship-from details before continuing.",
    );
    expect(markup).toContain("Continue to seller checkout");
  });

  it("shows latest seller confirmation as pending seller activity without completed downstream facts", () => {
    const markup = renderToString(
      <CheckoutSellListPage
        sellListLines={[]}
        latestConfirmation={latestConfirmation}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
      />,
    );

    expect(markup).toContain("Latest seller confirmation");
    expect(markup).toContain("Seller confirmation saved");
    expect(markup).toContain("CS-SL-CHK_SELL_1");
    expect(markup).toContain("Sale review saved");
    expect(markup).toContain("Next steps pending");
    expect(markup).toContain("Related sale references are available if support needs them.");
    expect(markup).not.toContain("slc_chk_sell_1");
    expect(markup).not.toContain("off_charizard");
    expect(markup).not.toContain("lst_charizard");
    expect(markup).not.toContain("Marketplace handoff");
    expect(markup).not.toContain("Pending downstream");
    expect(markup).not.toContain("Downstream references");
    expect(markup).toContain("View seller activity");
    expect(markup).toContain("View sales");
    expect(markup).toContain("View sale shipments");
    expect(markup).not.toContain("Sale complete");
    expect(markup).not.toContain("Completed");
    expect(markup).not.toContain("Label ready");
    expect(markup).not.toContain("Payout ready");
    expect(markup).not.toContain("Settlement complete");
    expect(markup).not.toContain("Account history updated");
  });

  it("shows guest selected-offer payout details through Reference Info without a fee fingerprint", () => {
    const guestSelectedOfferLine: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      line_id: "sll_guest_offer",
      offer_price_amount: "380.00",
      quantity: 1,
    };

    const { container } = render(
      <CheckoutSellListPage
        isSignedIn={false}
        sellListLines={[guestSelectedOfferLine]}
        offerReviews={[
          {
            lineId: "sll_guest_offer",
            status: "ready",
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "34.35",
              seller_net_unit_amount: "345.65",
              shipping_allowance_percentage_bps: 500,
              source_kind: "public-standard-seller-terms",
              source_label: "Standard seller terms",
              schedule_label: "Personal Default",
              source_updated_at: "2026-04-01T00:00:00.000Z",
              resolved_at: "2026-04-28T00:00:00.000Z",
            },
            comparison: null,
            message: null,
          },
        ]}
      />,
    );

    expect(screen.getAllByText("$345.65").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Estimated payout is ready using current standard seller terms. Create an account to review final terms before committing.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Create an account to continue seller checkout")).toBeTruthy();
    expect(screen.getAllByText("Create account to continue").length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        'a[href="/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'a[href="/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('input[name^="offerFeeQuoteFingerprint"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));

    const dialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(dialog).getByText("Estimated payout uses Standard seller terms.")).toBeTruthy();
    expect(within(dialog).getByText("Sales fee")).toBeTruthy();
    expect(within(dialog).getByText("$34.35")).toBeTruthy();
    expect(within(dialog).getByText("Shipping allowance")).toBeTruthy();
    expect(within(dialog).getByText("$19.00 (5%)")).toBeTruthy();
    expect(within(dialog).getByText("Terms source")).toBeTruthy();
    expect(within(dialog).getByText("Standard seller terms")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This estimate uses public standard seller terms because no seller account is attached yet.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "After registration, Checkout refreshes seller-specific terms before any offer acceptance or sale commitment.",
      ),
    ).toBeTruthy();
  });

  it("preserves Sell List handoff receipts in guest account-gate auth links", () => {
    const { container } = render(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine]}
        isSignedIn={false}
        sellerCheckoutRegisterHref="/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout%26afterWrite%3Dfresh%26postWriteHandoff%3Dhandoff"
        sellerCheckoutSignInHref="/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout%26afterWrite%3Dfresh%26postWriteHandoff%3Dhandoff"
      />,
    );

    expect(container.querySelector('a[href*="afterWrite%3Dfresh"]')).not.toBeNull();
    expect(container.querySelector('a[href*="postWriteHandoff%3Dhandoff"]')).not.toBeNull();
  });

  it("keeps registered term deltas in Reference Info with minimal row copy", () => {
    render(
      <CheckoutSellListPage
        sellListLines={[selectedOfferLine]}
        payoutReadiness={{ status: "ready", missing_requirements: [] }}
        registrationReturn="seller-checkout"
        mergedLineCount={1}
        offerReviews={[
          {
            lineId: "sll_offer",
            status: "ready",
            terms: {
              account_type: "business",
              basis_amount: "350.00",
              marketplace_sales_fee_unit_amount: "38.65",
              seller_net_unit_amount: "311.35",
              shipping_allowance_percentage_bps: 0,
              fee_quote_fingerprint: "registered_quote",
              schedule_id: "terms_business",
              agreement_id: "agreement_private",
              resolved_at: "2026-04-28T00:00:00.000Z",
            },
            comparison: {
              status: "changed",
              changedFields: ["seller-net", "marketplace-fee", "shipping-allowance", "terms-source"],
              standardPreview: {
                account_type: "personal",
                basis_amount: "350.00",
                marketplace_sales_fee_unit_amount: "35.00",
                seller_net_unit_amount: "315.00",
                shipping_allowance_percentage_bps: 500,
                source_kind: "public-standard-seller-terms",
                source_label: "Standard seller terms",
                schedule_label: "Personal Default",
                source_updated_at: "2026-04-01T00:00:00.000Z",
                resolved_at: "2026-04-28T00:00:00.000Z",
              },
            },
            message: null,
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Final terms changed from the standard estimate. Review payout details before continuing."),
    ).toBeTruthy();
    expect(screen.getAllByText("Continue to seller checkout").length).toBeGreaterThan(0);
    expect(screen.queryByText("agreement_private")).toBeNull();
    expect(screen.queryByText("registered_quote")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View estimated payout details" }));

    const dialog = screen.getByRole("dialog", { name: "Estimated payout" });
    expect(within(dialog).getByText("Standard estimate comparison")).toBeTruthy();
    expect(within(dialog).getByText("Standard estimate")).toBeTruthy();
    expect(within(dialog).getByText("$630.00")).toBeTruthy();
    expect(within(dialog).getByText("Final registered payout")).toBeTruthy();
    expect(within(dialog).getByText("$622.70")).toBeTruthy();
    expect(within(dialog).getByText("Payout change")).toBeTruthy();
    expect(within(dialog).getByText("-$7.30")).toBeTruthy();
    expect(within(dialog).getByText("Sales fee change")).toBeTruthy();
    expect(within(dialog).getByText("+$7.30")).toBeTruthy();
    expect(within(dialog).getByText("Shipping allowance change")).toBeTruthy();
    expect(within(dialog).getByText("-5%")).toBeTruthy();
    expect(within(dialog).getByText("Final terms source")).toBeTruthy();
    expect(within(dialog).getAllByText("Seller-specific terms").length).toBeGreaterThan(0);
    expect(
      within(dialog).getByText(
        "Final registered payout is lower than the standard estimate. Review the difference before continuing.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText("agreement_private")).toBeNull();
    expect(within(dialog).queryByText("registered_quote")).toBeNull();
  });

  it("uses a generic buyer label instead of raw account ids", () => {
    const lineWithoutPublicBuyerName: CheckoutSellListLineRow = {
      ...selectedOfferLine,
      buyer_account_id: "acc_private_buyer_id",
      buyer_display_name: null,
    };

    render(<CheckoutSellListPage sellListLines={[lineWithoutPublicBuyerName]} />);

    expect(screen.getAllByText("Buyer").length).toBeGreaterThan(0);
    expect(screen.queryByText("acc_private_buyer_id")).toBeNull();
  });
});
