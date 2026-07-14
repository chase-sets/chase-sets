import { expect, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";

export class MockCheckoutApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Checkout API error ${status}`);
  }
}

export class MockMarketplaceApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Marketplace API error ${status}`);
  }
}

export const mockRequireActorFromAuthApi = vi.fn();
export const mockResolveActorFromAuthApi = vi.fn();
export const mockCreateCheckoutRequestApiClient = vi.fn();
export const mockCreateMarketplaceRequestApiClient = vi.fn();
export const mockCreateSettlementRequestApiClient = vi.fn();
export const mockCreateOrderingRequestApiClient = vi.fn();
export const mockCreatePaymentsRequestApiClient = vi.fn();
export const mockGetAccountPayment = vi.fn();
export const mockCreateAuthRequestApiClient = vi.fn();
export const mockGetGuestCheckoutClaimContext = vi.fn();
export const mockCreateIdentityRequestApiClient = vi.fn();
export const mockCreateCheckoutSession = vi.fn();
export const mockCreateCartReadiness = vi.fn();
export const mockCreateSellListReadiness = vi.fn();
export const mockCreateGuestSellListReadiness = vi.fn();
export const mockGetCheckoutSession = vi.fn();
export const mockGetCheckoutPaymentSummary = vi.fn();
export const mockGetCheckoutPaymentConfirmation = vi.fn();
export const mockPreviewCheckoutFulfillment = vi.fn();
export const mockGetCheckoutStatus = vi.fn();
export const mockPreviewCheckoutStatus = vi.fn();
export const mockSelectShippingOption = vi.fn();
export const mockSelectShippingAddress = vi.fn();
export const mockSelectAuthenticityCheckOptIn = vi.fn();
export const mockRecordFulfillmentPreview = vi.fn();
export const mockConfirmCheckoutSession = vi.fn();
export const mockStartGuestCheckout = vi.fn();
export const mockMergeGuestCartToAccount = vi.fn();
export const mockGetCart = vi.fn();
export const mockGetGuestCart = vi.fn();
export const mockUpdateCartLineQuantity = vi.fn();
export const mockUpdateGuestCartLineQuantity = vi.fn();
export const mockUpdateCartLineFulfillment = vi.fn();
export const mockUpdateGuestCartLineFulfillment = vi.fn();
export const mockRemoveCartLine = vi.fn();
export const mockRemoveGuestCartLine = vi.fn();
export const mockGetGuestSellList = vi.fn();
export const mockGetSellListCompositeReview = vi.fn();
export const mockGetGuestSellListOfferReviews = vi.fn();
export const mockGetOfferMatch = vi.fn();
export const mockGetPublicOffer = vi.fn();
export const mockListOfferMatches = vi.fn();
export const mockPreviewPublicStandardListingTerms = vi.fn();
export const mockPreviewOfferAcceptanceTerms = vi.fn();
export const mockAcceptOfferMatch = vi.fn();
export const mockCreateListing = vi.fn();
export const mockPublishListing = vi.fn();
export const mockGetPayoutReadiness = vi.fn();
export const mockAddSellListLine = vi.fn();
export const mockAddGuestSellListLine = vi.fn();
export const mockGetSellListConfirmation = vi.fn();
export const mockConfirmSellListCheckout = vi.fn();
export const mockRemoveGuestSellListLine = vi.fn();
export const mockMergeGuestSellListToAccount = vi.fn();
export const mockListShippingAddresses = vi.fn();
export const mockListSellListShipFromAddresses = vi.fn();

export function applyCheckoutRouteMockDefaults() {
  mockGetSellListConfirmation.mockRejectedValue(new MockCheckoutApiError(404, { error: { code: "not_found" } }));
  mockConfirmSellListCheckout.mockImplementation(async (body: { confirmationId: string; handoffSummary: unknown }) => ({
    confirmation: {
      seller_account_id: "acc_seller",
      confirmation_id: body.confirmationId,
      confirmed_at: "2026-06-10T00:00:00.000Z",
      readiness_evidence: {},
      seller_evidence: {},
      handoff_summary: body.handoffSummary,
    },
    commandReceipt: checkoutCommit("42", "evt_checkout_sell_list_confirmed"),
  }));
  mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
  mockCreateListing.mockResolvedValue({
    id: "lst_slc_chk_sell_1_sll_1",
    status: "draft",
    feeQuoteFingerprint: "listing_quote_1",
  });
  mockPublishListing.mockResolvedValue({ status: "published" });
  mockCreateSettlementRequestApiClient.mockReturnValue({
    getPayoutReadiness: mockGetPayoutReadiness.mockResolvedValue({
      account_id: "acc_seller",
      status: "ready",
      missing_requirements: [],
      provider_reference: "acct_1",
      onboarding_status: "complete",
      transfer_capability_status: "active",
      payout_capability_status: "active",
      payout_destination_status: "ready",
      updated_at: "2026-05-30T00:00:00.000Z",
    }),
  });
  mockCreateIdentityRequestApiClient.mockReturnValue({
    listShippingAddresses: mockListShippingAddresses.mockResolvedValue({ items: [] }),
  });
  mockGetSellListCompositeReview.mockResolvedValue({
    offerReviews: [],
    productOfferReviews: [],
    inventoryItems: [],
  });
  mockGetGuestSellListOfferReviews.mockResolvedValue({ offerReviews: [] });
  mockListSellListShipFromAddresses.mockResolvedValue({
    items: [
      {
        shipping_address_id: "adr_seller",
        account_id: "acc_seller",
        label: "Warehouse",
        recipient_name: "Jane Seller",
        company: null,
        line1: "100 Market Street",
        line2: null,
        city: "Wichita",
        state: "KS",
        postal_code: "67202",
        country: "US",
        phone: "316-555-0110",
        email: "seller@example.com",
        is_default: true,
        updated_at: "2026-05-30T00:00:00.000Z",
      },
    ],
  });
  mockCreateCartReadiness.mockResolvedValue(readyCartReadinessResponse());
  mockCreateSellListReadiness.mockResolvedValue(readySellListReadinessResponse());
  mockCreateGuestSellListReadiness.mockResolvedValue(readySellListReadinessResponse());
  mockPreviewOfferAcceptanceTerms.mockImplementation(async (offerId: string) => ({
    account_type: "personal",
    basis_amount: "38.00",
    marketplace_sales_fee_unit_amount: "3.80",
    seller_net_unit_amount: "34.20",
    shipping_allowance_percentage_bps: 0,
    schedule_id: "terms_standard",
    agreement_id: null,
    resolved_at: "2026-06-10T00:00:00.000Z",
    fee_quote_fingerprint: offerId === "off_product_1" ? "quote_product_1" : "quote_1",
  }));
}

export function guestCheckoutActor() {
  return {
    sessionId: "guest:tok_1",
    tenantId: "tnt_identity",
    userId: "usr_guest_checkout",
    accountId: "acc_guest",
    membershipId: "guest:tok_1",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  };
}

export function checkoutCommit(position: string, eventId: string) {
  return {
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "checkout",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
}

export function readyCartReadinessResponse() {
  return {
    readiness: {
      schemaVersion: "checkout.cart-readiness.v1",
      source: "cart",
      sourceRevision: "cr_source",
      snapshotId: "cr_ready",
      status: "ready",
      lineCount: 1,
      includedLineIds: ["cart_line_1"],
      unresolvedLineIds: [],
      lineOutcomes: [{ lineId: "cart_line_1", outcome: "checkout", reason: "ready" }],
      optimization: {
        available: false,
        decision: "none",
        proposedLineId: null,
        proposedListingId: null,
        currentListingId: null,
        savingsAmount: null,
        currency: "USD",
      },
      customerSafeFacts: ["Ready for checkout."],
    },
  };
}

export function readySellListReadinessResponse() {
  return {
    readiness: {
      schemaVersion: "checkout.sell-list-readiness.v1",
      source: "sell-list",
      sourceRevision: "slr_source",
      snapshotId: "slr_ready",
      status: "ready",
      lineCount: 1,
      includedLineIds: ["sll_1"],
      unresolvedLineIds: [],
      lineOutcomes: [{ lineId: "sll_1", outcome: "checkout", reason: "ready", action: "selected-offer" }],
      sellerReadiness: {
        status: "ready",
        evidenceRevision: "slr_seller_evidence",
        payout: "ready",
        shipFrom: "ready",
        label: "ready",
        listingEvidence: "ready",
        risk: "ready",
        provider: "ready",
        freshness: "ready",
        outcomes: [
          { dimension: "ship-from", status: "ready", reason: "ready" },
          { dimension: "payout", status: "ready", reason: "ready" },
          { dimension: "label", status: "ready", reason: "ready" },
          { dimension: "listing-evidence", status: "ready", reason: "ready" },
          { dimension: "risk", status: "ready", reason: "ready" },
          { dimension: "provider", status: "ready", reason: "ready" },
          { dimension: "freshness", status: "ready", reason: "ready" },
        ],
      },
      customerSafeFacts: ["Ready for seller checkout."],
    },
  };
}

export function guestSellListLine(overrides: Record<string, unknown> = {}) {
  return {
    seller_account_id: "anon_sell_1",
    line_id: "sll_1",
    line_type: "selected-offer",
    offer_id: "off_1",
    listing_id: "lst_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    offer_price_amount: "38.00",
    catalog_catalog_item_id: "cat_1",
    product_id: "prod_1",
    item_title: "Acerola's Mischief",
    item_subtitle: "Raw / Damaged",
    selected_options: [{ dimensionId: "Condition", optionId: "Damaged" }],
    product_summary: "Raw card",
    quantity: 1,
    fallback_mode: "none",
    minimum_listing_price_amount: null,
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

export function freshCheckoutRequest(path = "/checkout/buy/session/chk_1") {
  return new Request(`http://localhost${appendFreshWriteToken(path, checkoutCommit("42", "evt_checkout"))}`);
}

export function expectNoSellerCommitSideEffects() {
  expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  expect(mockCreateListing).not.toHaveBeenCalled();
  expect(mockPublishListing).not.toHaveBeenCalled();
  expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
}
