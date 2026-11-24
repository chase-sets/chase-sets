import { deriveSellListCompositeReview } from "../../features/sell-list/read-model/screen-review";
import type { SellListReviewReadiness } from "../../features/sell-list/api/review-plan-contracts";
import { expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import type { PaymentsCheckoutStatus } from "@chase-sets/payments/server";
import { compareMoneyAmounts, subtractMoneyAmounts } from "@chase-sets/primitives/money";

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
export const mockCreateInternalAuthRequestApiClient = vi.fn();
export const mockGetGuestCheckoutContact = vi.fn();
export const mockBindGuestCheckoutContact = vi.fn();
/** The contact Auth reports for a guest checkout that has already saved one. */
export const BOUND_GUEST_CONTACT_BODY = { contactEmail: "guest@example.com", contactName: "Guest Buyer" } as const;
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
export const mockSubmitCartCommands = vi.fn();
export const mockSubmitGuestCartCommands = vi.fn();
export const mockGetCartCommandAttempt = vi.fn();
export const mockGetGuestCartCommandAttempt = vi.fn();
export const mockGetGuestSellList = vi.fn();
export const mockGetSellListCompositeReview = vi.fn();
export const mockGetGuestSellListOfferReviews = vi.fn();
export const mockGetGuestSellListCompositeReview = vi.fn();
export const mockGetOfferMatch = vi.fn();
export const mockGetPublicOffer = vi.fn();
export const mockListOfferMatches = vi.fn();
export const mockPreviewPublicStandardListingTerms = vi.fn();
export const mockPreviewOfferAcceptanceTerms = vi.fn();
export const mockAcceptOfferMatch = vi.fn();
export const mockGetOfferAcceptanceAttempt = vi.fn();
export const mockDeclineOfferMatch = vi.fn();
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

/**
 * The checkout processing-fee policy value the Payments preview stand-in quotes against: 2.9% plus
 * $0.30 for card, 0.5% for bank account and nothing for platform credit. It is an input the route
 * tests state for themselves, so their expected fee amounts can be derived from it.
 */
const quotedCheckoutProcessingFeePolicyValue: Parameters<
  typeof import("@chase-sets/payments/server").quoteMarketplaceCheckoutFee
>[1] = {
  enabledJurisdictions: ["US"],
  base: { percentageBps: 290, fixedAmount: "0.30" },
  methodAdjustments: [
    { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
    { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
    { paymentMethodCategory: "platform-credit", percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
  ],
};

/**
 * What Payments' checkout preview-status answers under the launch fee policy, with a balance-credit
 * resolver that grants the requested credit up to the amount.
 */
export async function paymentsCheckoutPreviewStatus(
  params: Readonly<{
    amount: string;
    currencyCode?: string | null;
    requestedBalanceCreditAmount?: string | null;
    paymentMethodCategory?: string | null;
  }>,
): Promise<PaymentsCheckoutStatus> {
  // Loaded when called: test files mock @chase-sets/payments/server with factories that read this module.
  const {
    marketplaceCheckoutFeePaymentMethodCategories,
    normalizeMarketplaceCheckoutFeePaymentMethodCategory,
    quoteMarketplaceCheckoutFee,
  } = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");
  const requested = params.requestedBalanceCreditAmount || "0.00";
  const applied = compareMoneyAmounts(requested, params.amount) <= 0 ? requested : params.amount;
  const external = subtractMoneyAmounts(params.amount, applied);
  const quotes = marketplaceCheckoutFeePaymentMethodCategories.map((method) =>
    quoteMarketplaceCheckoutFee(
      {
        orderAmount: params.amount,
        externalBasisAmount: external,
        balanceCreditAmount: applied,
        paymentMethodCategory: method,
      },
      quotedCheckoutProcessingFeePolicyValue,
    ),
  );
  const method = normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory);
  const payable = compareMoneyAmounts(params.amount, "0.00") > 0;
  return {
    order_ids: [],
    currency_code: (params.currencyCode || "usd").toLowerCase(),
    amount: params.amount,
    marketplace_checkout_fee: quotes.find((quote) => quote.payment_method_category === method) ?? quotes[0]!,
    payment_method_quotes: quotes,
    wallet_credit: { requested_amount: requested, applied_amount: applied, external_amount: external },
    can_start_payment: payable,
    unavailable_reasons: payable ? [] : ["no-payable-order-balance"],
    unavailable_reason_details: payable
      ? []
      : [{ code: "no-payable-order-balance", message: "No payable order balance is available." }],
  };
}

/** Payments' preview-status answer for a request to it, or null for any other URL. */
export async function paymentsCheckoutPreviewStatusResponse(input: RequestInfo | URL): Promise<Response | null> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.pathname.endsWith("/account/checkout/preview-status")) return null;
  return Response.json(
    await paymentsCheckoutPreviewStatus({
      amount: url.searchParams.get("amount") ?? "0.00",
      currencyCode: url.searchParams.get("currencyCode"),
      requestedBalanceCreditAmount: url.searchParams.get("requestedBalanceCreditAmount"),
      paymentMethodCategory: url.searchParams.get("paymentMethodCategory"),
    }),
  );
}

export function applyCheckoutRouteMockDefaults() {
  mockGetGuestCheckoutContact.mockResolvedValue(BOUND_GUEST_CONTACT_BODY);
  mockBindGuestCheckoutContact.mockResolvedValue({ accountId: "acc_guest", ...BOUND_GUEST_CONTACT_BODY });
  mockCreateInternalAuthRequestApiClient.mockReturnValue({
    getGuestCheckoutContact: mockGetGuestCheckoutContact,
    bindGuestCheckoutContact: mockBindGuestCheckoutContact,
  });
  mockPreviewCheckoutStatus.mockImplementation(paymentsCheckoutPreviewStatus);
  mockCreatePaymentsRequestApiClient.mockReturnValue({ previewCheckoutStatus: mockPreviewCheckoutStatus });
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
  mockGetOfferAcceptanceAttempt.mockImplementation(async (offerId, body) => {
    const actual = await vi.importActual<typeof import("@chase-sets/marketplace/server")>(
      "@chase-sets/marketplace/server",
    );
    return {
      schemaVersion: 1,
      mutationKind: "offer.accept",
      ownerStatus: "committed",
      actorBinding: { accountId: "acc_seller" },
      target: { kind: "offer", id: offerId },
      attemptKeyFingerprint: createHash("sha256").update(body.sourceActionKey).digest("hex"),
      canonicalRequestHash: actual.hashMarketplaceRequest(
        actual.marketplaceOfferCanonicalRequest("offer.accept", { ...body, offerId }),
      ),
      ownerReceipt: { id: offerId, version: 2 },
    };
  });
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
  mockGetSellListCompositeReview.mockResolvedValue(
    deriveSellListCompositeReview({
      lines: [],
      isAccount: true,
      payoutReadiness: { account_id: "acc_seller", status: "ready", missing_requirements: [], updated_at: null },
      review: { offerReviews: [], productOfferReviews: [], inventoryItems: [] },
    }),
  );
  mockGetGuestSellListOfferReviews.mockResolvedValue({ offerReviews: [] });
  mockGetGuestSellListCompositeReview.mockResolvedValue(
    deriveSellListCompositeReview({
      lines: [],
      isAccount: false,
      review: { offerReviews: [], productOfferReviews: [], inventoryItems: [] },
    }),
  );
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

export function readySellListReadinessResponse(): SellListReviewReadiness {
  return {
    reviewPlan: {
      version: 1,
      lines: [
        {
          lineId: "sll_1",
          lineType: "selected-offer",
          itemTitle: "Mewtwo",
          productId: "prod_1",
          quantity: 1,
          selectedOffer: { offerId: "off_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1" },
          productOfferTargets: [],
          fallbackListing: null,
          skippedReasons: [],
        },
      ],
    },
    decisions: { lineActions: [{ lineId: "sll_1", action: "selected-offer" }], lineOutcomes: [] },
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
