import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  expectNoSellerCommitSideEffects,
  guestSellListLine,
  mockAcceptOfferMatch,
  MockCheckoutApiError,
  mockConfirmSellListCheckout,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateGuestSellListReadiness,
  mockCreateIdentityRequestApiClient,
  mockCreateListing,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateSellListReadiness,
  mockCreateSettlementRequestApiClient,
  mockGetGuestSellList,
  mockGetPayoutReadiness,
  mockGetSellListConfirmation,
  mockListSellListShipFromAddresses,
  MockMarketplaceApiError,
  mockPreviewOfferAcceptanceTerms,
  mockPublishListing,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  readySellListReadinessResponse,
} from "../tests/support/checkout-route-test-harness";

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveActorFromAuthApi: mockResolveActorFromAuthApi,
  };
});

vi.mock("@chase-sets/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth/server")>("@chase-sets/auth/server");

  return {
    ...actual,
    createAuthRequestApiClient: mockCreateAuthRequestApiClient,
  };
});

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");

  return {
    ...actual,
    createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  CheckoutApiError: MockCheckoutApiError,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: mockCreateOrderingRequestApiClient,
}));

vi.mock("@chase-sets/payments/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");

  return {
    ...actual,
    createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
    normalizeRequestedBalanceCreditAmount: (value: unknown) => {
      const text = String(value ?? "").trim();
      return text ? text : null;
    },
  };
});

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  MarketplaceApiError: MockMarketplaceApiError,
}));

vi.mock("@chase-sets/settlement/server", () => ({
  createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
}));

import { action as sellCheckoutSessionAction, loader as sellCheckoutSessionLoader } from "./sell-checkout-session";

async function readResolvedFreshWriteToken(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return readFreshWriteToken(resolvedRequest.url);
}

describe("checkout web routes: sell checkout session", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads guest seller checkout only when Sell List readiness still matches", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_ready&readinessSourceRevision=slr_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expect(result.recovery).toBeNull();
    expect(result.readiness?.snapshotId).toBe("slr_ready");
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  it("fails guest seller checkout closed when readiness is stale", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_old&readinessSourceRevision=slr_old_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.recovery).toEqual({ kind: "readiness-stale" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  it("fails guest seller checkout closed when readiness is unresolved", async () => {
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateGuestSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_1"],
        includedLineIds: [],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(
        "http://localhost/checkout/sell/session/chk_sell_1?readinessSnapshotId=slr_ready&readinessSourceRevision=slr_source",
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.recovery).toEqual({ kind: "readiness-blocked" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  function signedInSellerActor() {
    return {
      accountId: "acc_seller",
      roleKey: "seller",
      permissions: ["accounts.view"],
    };
  }

  function signedInSellCheckoutUrl(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({ version: 1, lines: [{ lineId: "sll_1", lineType: "selected-offer" }] }),
      ...overrides,
    });
    return `http://localhost/checkout/sell/session/chk_sell_1?${params.toString()}`;
  }

  it("loads signed-in seller checkout from current Sell List readiness and saved rows", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl()),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.mode).toBe("signed-in");
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect(result.recovery).toBeNull();
    expect(result.readiness?.snapshotId).toBe("slr_ready");
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
    expect(result.mode === "signed-in" ? result.defaultValues.email : "").toBe("seller@example.com");
    expect(result.mode === "signed-in" ? result.defaultValues.shipFromLine1 : "").toBe("100 Market Street");
    expect(result.mode === "signed-in" ? result.payoutSummary?.status : "").toBe("ready");
    expect(result.mode === "signed-in" ? result.sellListReviewPlan : "").toContain('"version":1');
  });

  it("fails signed-in seller checkout closed when Sell List readiness is stale", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        snapshotId: "slr_new",
        sourceRevision: "slr_source",
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });

    const result = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl()),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.mode).toBe("signed-in");
    expect(result.recovery).toEqual({ kind: "readiness-stale" });
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
  });

  function guestSellCheckoutForm(overrides: Record<string, string> = {}) {
    const form = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      sellerName: "Jane Seller",
      email: "jane@example.com",
      phone: "555-0100",
      shipFromName: "Jane Seller",
      company: "",
      shipFromLine1: "100 Market St",
      shipFromLine2: "",
      shipFromCity: "Wichita",
      shipFromState: "KS",
      shipFromPostalCode: "67202",
      shipFromCountry: "US",
      payoutHandoff: "create-account",
      labelPreference: "prepaid-label",
      termsAccepted: "accepted",
      payoutState: "ready",
      payoutEstimateState: "current",
      riskState: "clear",
      labelState: "ready",
      ...overrides,
    });
    return form;
  }

  function signedInSellCheckoutForm(overrides: Record<string, string> = {}) {
    const form = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
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
      }),
      sellerName: "Jane Seller",
      email: "jane@example.com",
      phone: "555-0100",
      shipFromAddressId: "adr_seller",
      shipFromName: "Jane Seller",
      company: "",
      shipFromLine1: "100 Market St",
      shipFromLine2: "",
      shipFromCity: "Wichita",
      shipFromState: "KS",
      shipFromPostalCode: "67202",
      shipFromCountry: "US",
      payoutMethod: "saved-payout",
      labelPreference: "prepaid-label",
      termsAccepted: "accepted",
      payoutState: "ready",
      payoutEstimateState: "current",
      riskState: "clear",
      labelState: "ready",
      sellerReadinessState: "ready",
      ...overrides,
    });
    return form;
  }

  function mockSignedInSellCheckoutState() {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });
  }

  async function expectSellConfirmationRedirect(
    result: unknown,
    options: Readonly<{ freshWrite?: "required" | "absent" }> = { freshWrite: "required" },
  ) {
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    const url = new URL(location, "http://localhost");
    expect(url.pathname).toBe("/checkout/sell/session/chk_sell_1/confirmation");
    if (options.freshWrite === "absent") {
      expect(url.searchParams.has("afterWrite")).toBe(false);
      expect(url.searchParams.has("postWriteToken")).toBe(false);
      return;
    }

    expect(readCompactPostWriteToken(url)).toMatch(/^pwt_/);
    expect(url.searchParams.has("afterWrite")).toBe(false);
    expect(url.searchParams.has("postWriteHandoff")).toBe(false);
    expect(await readResolvedFreshWriteToken(url)).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          sourceContextName: "checkout",
        }),
      ]),
    });
  }

  it("validates signed-in seller checkout saved fields without side effects", async () => {
    mockSignedInSellCheckoutState();

    const form = signedInSellCheckoutForm({
      email: "",
      shipFromAddressId: "__manual",
      shipFromLine1: "",
      termsAccepted: "",
    });
    form.delete("termsAccepted");

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors : {}).toEqual(
      expect.objectContaining({
        email: "Enter a valid email address.",
        shipFromLine1: "Enter address line 1.",
        termsAccepted: "Confirm that you reviewed the final seller terms and sale details.",
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("uses the selected saved ship-from address before signed-in validation", async () => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          shipFromAddressId: "adr_seller",
          shipFromLine1: "",
          shipFromCity: "",
          shipFromPostalCode: "",
        }).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationId: "slc_chk_sell_1",
        sellerEvidence: expect.objectContaining({
          shipFrom: expect.objectContaining({
            addressId: "adr_seller",
            country: "US",
            region: "KS",
            postalCode: "67202",
          }),
        }),
      }),
    );
  });

  it.each([
    [
      "unsupported ship-from",
      { shipFromAddressId: "__manual", shipFromState: "PR" },
      "shipFromState",
      "This ship-from region is not supported",
    ],
    ["payout setup required", { payoutState: "setup-required" }, "payoutMethod", "Payout setup is required"],
    ["payout setup failure", { payoutState: "failed" }, "payoutMethod", "Payout setup is temporarily unavailable"],
    ["changed payout", { payoutEstimateState: "changed" }, "form", "The payout estimate changed"],
    ["risk hold", { riskState: "hold" }, "form", "This sale review needs support review"],
    ["risk block", { riskState: "block" }, "form", "This sale review cannot continue"],
    ["label failure", { labelState: "failed" }, "labelPreference", "Label readiness is unavailable"],
    ["seller readiness failure", { sellerReadinessState: "blocked" }, "form", "Seller readiness needs review"],
  ])("blocks signed-in seller checkout on %s without side effects", async (_label, overrides, fieldName, message) => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm(overrides).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors[fieldName as keyof typeof result.fieldErrors] : "").toContain(
      message,
    );
    expectNoSellerCommitSideEffects();
  });

  it("redirects to seller confirmation after recording reviewed sale details", async () => {
    mockSignedInSellCheckoutState();

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockGetSellListConfirmation).toHaveBeenCalledWith("slc_chk_sell_1");
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationId: "slc_chk_sell_1",
        readinessSnapshotId: "slr_ready",
        readinessSourceRevision: "slr_source",
        completedLineIds: ["sll_1"],
        remainingLineQuantities: [],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 1,
          publishedListingCount: 0,
          skippedLineCount: 0,
          sideEffects: {
            sale: "handoff-recorded",
            label: "pending-downstream",
            payout: "pending-downstream",
            settlement: "pending-downstream",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        }),
      }),
    );
  });

  it("carries the Marketplace accepted-offer receipt into the seller confirmation redirect", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockResolvedValueOnce({
      status: "accepted",
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "55",
          eventIds: ["evt_marketplace_offer_accepted"],
        },
      ],
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    const location = (result as Response).headers.get("Location") ?? "";
    expect(await readResolvedFreshWriteToken(new URL(location, "http://localhost"))).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          sourceContextName: "checkout",
        }),
        expect.objectContaining({
          sourceContextName: "marketplace",
          maxGlobalPosition: "55",
          eventIds: ["evt_marketplace_offer_accepted"],
        }),
      ]),
    });
  });

  it("redirects duplicate seller confirmation posts to the existing confirmation without replaying handoff", async () => {
    mockSignedInSellCheckoutState();
    mockGetSellListConfirmation.mockResolvedValue({
      seller_account_id: "acc_seller",
      confirmation_id: "slc_chk_sell_1",
      confirmed_at: "2026-06-10T00:00:00.000Z",
      readiness_evidence: {},
      seller_evidence: {},
      handoff_summary: {
        acceptedOfferCount: 1,
        publishedListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        lineOutcomes: [],
        sideEffects: {
          sale: "handoff-recorded",
          label: "pending-downstream",
          payout: "pending-downstream",
          settlement: "pending-downstream",
          notification: "pending-downstream",
          accountHistory: "pending-downstream",
        },
      },
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result, { freshWrite: "absent" });
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(mockPublishListing).not.toHaveBeenCalled();
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("does not replay seller handoff when duplicate confirmation lookup is unavailable", async () => {
    const failure = new MockCheckoutApiError(503, { error: { code: "checkout_unavailable" } });
    mockSignedInSellCheckoutState();
    mockGetSellListConfirmation.mockRejectedValue(failure);

    await expect(
      sellCheckoutSessionAction({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: signedInSellCheckoutForm().toString(),
        }),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never),
    ).rejects.toBe(failure);

    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expectNoSellerCommitSideEffects();
  });

  it("accepts selected-offer handoff without re-reading Marketplace offer terms", async () => {
    mockSignedInSellCheckoutState();
    mockPreviewOfferAcceptanceTerms.mockResolvedValueOnce({
      account_type: "personal",
      basis_amount: "38.00",
      marketplace_sales_fee_unit_amount: "4.20",
      seller_net_unit_amount: "33.80",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_standard",
      agreement_id: null,
      resolved_at: "2026-06-10T00:02:00.000Z",
      fee_quote_fingerprint: "quote_changed",
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
  });

  it("does not block selected-offer handoff when Marketplace terms preview is unavailable", async () => {
    mockSignedInSellCheckoutState();
    mockPreviewOfferAcceptanceTerms.mockRejectedValueOnce(new Error("terms unavailable"));

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", {
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
    });
  });

  it("rejects hidden fallback listing facts on selected-offer confirmation before side effects", async () => {
    mockSignedInSellCheckoutState();

    const form = signedInSellCheckoutForm({
      sellListReviewPlan: JSON.stringify({
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
            fallbackListing: { inventoryItemId: "inv_extra", priceAmount: "40.00", quantityCap: 1 },
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors.form : "").toContain(
      "Return to the Sell List and refresh the reviewed sale plan",
    );
    expectNoSellerCommitSideEffects();
  });

  it("records fallback-only listing work without claiming sale or payout side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 1,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "fallback-listing" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 1,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          readinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "fallback-listing" }],
            lineOutcomes: [],
          }),
          sellListReviewPlan: JSON.stringify({
            version: 1,
            lines: [
              {
                lineId: "sll_product",
                lineType: "product",
                itemTitle: "Mewtwo",
                productId: "prod_1",
                quantity: 1,
                selectedOffer: null,
                productOfferTargets: [],
                fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
                skippedReasons: [],
              },
            ],
          }),
        }).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).toHaveBeenCalledWith({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        completedLineIds: ["sll_product"],
        remainingLineQuantities: [],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 0,
          publishedListingCount: 1,
          sideEffects: {
            sale: "not-applicable",
            label: "not-applicable",
            payout: "not-applicable",
            settlement: "not-applicable",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        }),
      }),
    );
  });

  it("performs Smart Match handoff without re-reading Marketplace offer terms", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 2,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 2,
            minimum_listing_price_amount: null,
          }),
        ],
        count: 2,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockPreviewOfferAcceptanceTerms.mockResolvedValueOnce({
      account_type: "personal",
      basis_amount: "38.00",
      marketplace_sales_fee_unit_amount: "5.00",
      seller_net_unit_amount: "33.00",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_standard",
      agreement_id: null,
      resolved_at: "2026-06-10T00:03:00.000Z",
      fee_quote_fingerprint: "quote_product_changed",
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          readinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "smart-match" }],
            lineOutcomes: [],
          }),
          sellListReviewPlan: JSON.stringify({
            version: 1,
            lines: [
              {
                lineId: "sll_product",
                lineType: "product",
                itemTitle: "Mewtwo",
                productId: "prod_1",
                quantity: 2,
                selectedOffer: null,
                productOfferTargets: [
                  {
                    offerId: "off_product_1",
                    listingId: "lst_product_1",
                    feeQuoteFingerprint: "quote_product_1",
                    quantity: 1,
                  },
                ],
                fallbackListing: null,
                skippedReasons: [],
              },
            ],
          }),
        }).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", {
      listingId: "lst_product_1",
      feeQuoteFingerprint: "quote_product_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_product:match:off_product_1",
      acceptanceBatchId: "offer-acceptance:slc_chk_sell_1:sll_product",
      acceptanceBatchSize: 1,
    });
  });

  it("records Smart Match and fallback listing work with remaining Sell List quantity on publish replay", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 4,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 4,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 4,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockCreateListing.mockResolvedValue({
      id: "lst_slc_chk_sell_1_sll_product",
      status: "draft",
      feeQuoteFingerprint: "listing_quote_1",
    });
    mockPublishListing.mockRejectedValueOnce(
      new MockMarketplaceApiError(400, { error: { message: "Listing is already active." } }),
    );
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_product",
            lineType: "product",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 4,
            selectedOffer: null,
            productOfferTargets: [
              {
                offerId: "off_product_1",
                listingId: "lst_product_1",
                feeQuoteFingerprint: "quote_product_1",
                quantity: 1,
              },
            ],
            fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    await expectSellConfirmationRedirect(result);
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_product_1", {
      listingId: "lst_product_1",
      feeQuoteFingerprint: "quote_product_1",
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_product:match:off_product_1",
      acceptanceBatchId: "offer-acceptance:slc_chk_sell_1:sll_product",
      acceptanceBatchSize: 1,
    });
    expect(mockCreateListing).toHaveBeenCalledWith({
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockPublishListing).toHaveBeenCalledWith("lst_slc_chk_sell_1_sll_product", {
      feeQuoteFingerprint: "listing_quote_1",
    });
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        completedLineIds: [],
        remainingLineQuantities: [{ lineId: "sll_product", quantity: 2 }],
        handoffSummary: expect.objectContaining({
          acceptedOfferCount: 1,
          publishedListingCount: 1,
          lineOutcomes: [
            expect.objectContaining({
              lineId: "sll_product",
              status: "partial",
              action: "mixed",
              remainingQuantity: 2,
              references: {
                offerIds: ["off_product_1"],
                listingId: "lst_slc_chk_sell_1_sll_product",
              },
            }),
          ],
        }),
      }),
    );
  });

  it("rejects signed-in seller confirmation when the reviewed plan exceeds current line quantity", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          guestSellListLine({
            seller_account_id: "acc_seller",
            line_id: "sll_product",
            line_type: "product",
            offer_id: null,
            offer_price_amount: null,
            quantity: 1,
            minimum_listing_price_amount: "12.00",
          }),
        ],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      readinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      sellListReviewPlan: JSON.stringify({
        version: 1,
        lines: [
          {
            lineId: "sll_product",
            lineType: "product",
            itemTitle: "Mewtwo",
            productId: "prod_1",
            quantity: 1,
            selectedOffer: null,
            productOfferTargets: [
              {
                offerId: "off_product_1",
                listingId: "lst_product_1",
                feeQuoteFingerprint: "quote_product_1",
                quantity: 2,
              },
            ],
            fallbackListing: null,
            skippedReasons: [],
          },
        ],
      }),
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors.form : "").toContain(
      "Return to the Sell List and refresh the reviewed sale plan",
    );
    expectNoSellerCommitSideEffects();
  });

  it("validates guest seller checkout contact and ship-from fields without side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = guestSellCheckoutForm({ email: "", shipFromLine1: "", termsAccepted: "" });
    form.delete("termsAccepted");

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors : {}).toEqual(
      expect.objectContaining({
        email: "Enter a valid email address.",
        shipFromLine1: "Enter address line 1.",
        termsAccepted: "Confirm that you reviewed the final seller terms and sale details.",
      }),
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported ship-from", { shipFromState: "PR" }, "shipFromState", "This ship-from region is not supported"],
    ["payout setup required", { payoutState: "setup-required" }, "payoutHandoff", "Payout setup is required"],
    ["payout setup failure", { payoutState: "failed" }, "payoutHandoff", "Payout setup is temporarily unavailable"],
    ["changed payout", { payoutEstimateState: "changed" }, "form", "The payout estimate changed"],
    ["risk hold", { riskState: "hold" }, "form", "This sale review needs support review"],
    ["risk block", { riskState: "block" }, "form", "This sale review cannot continue"],
    ["label failure", { labelState: "failed" }, "labelPreference", "Label readiness is unavailable"],
  ])("blocks guest seller checkout on %s without side effects", async (_label, overrides, fieldName, message) => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: guestSellCheckoutForm(overrides).toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.fieldErrors[fieldName as keyof typeof result.fieldErrors] : "").toContain(
      message,
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("routes guest seller checkout through registration before seller-committing side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [guestSellListLine()], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: guestSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expectNoSellerCommitSideEffects();
  });
});
