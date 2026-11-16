import type { SellListReviewPlan, SellListReadinessDecisionInput } from "../support/request-support/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  expectNoSellerCommitSideEffects,
  guestSellListLine,
  mockAcceptOfferMatch,
  mockGetOfferAcceptanceAttempt,
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
  mockGetGuestSellList,
  mockGetPayoutReadiness,
  mockGetSellListConfirmation,
  mockListSellListShipFromAddresses,
  MockMarketplaceApiError,
  mockPreviewOfferAcceptanceTerms,
  mockPublishListing,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockRemoveGuestSellListLine,
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

vi.mock("@chase-sets/marketplace/server", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/marketplace/server")>("@chase-sets/marketplace/server")),
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  MarketplaceApiError: MockMarketplaceApiError,
}));

import { action as sellCheckoutSessionAction, loader as sellCheckoutSessionLoader } from "./sell-checkout-session";
import { loader as sellCheckoutConfirmationLoader } from "./sell-checkout-confirmation";

async function readResolvedFreshWriteToken(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return readFreshWriteToken(resolvedRequest.url);
}

describe("checkout web routes: sell checkout session", () => {
  it.each(["selected", "match"])(
    "Marketplace accepts the unchanged Checkout %s key; a base64url-only mutant refuses it",
    async (kind) => {
      const actual = await vi.importActual<typeof import("@chase-sets/marketplace/server")>(
        "@chase-sets/marketplace/server",
      );
      const key = `sell-confirm:slc_chk_sell_1:sll_1:${kind}:off_1`;
      const transport = vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "off_1", version: 2 }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", transport);
      const api = actual.createMarketplaceRequestApiClient(new Request("http://localhost"));
      expect(/^[A-Za-z0-9_-]{22,128}$/.test(key)).toBe(false);
      await expect(api.acceptOfferMatch("off_1", { sourceActionKey: key, listingId: "lst_1" })).resolves.toMatchObject({
        id: "off_1",
        version: 2,
      });
      expect(transport).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    },
  );
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
      confirmationId: "slc_chk_sell_1",
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
    });
    expect(result.recovery).toBeNull();
    expect(result.readiness?.snapshotId).toBe("slr_ready");
    expect(result.lines).toEqual([expect.objectContaining({ line_id: "sll_1" })]);
    expect(result.mode === "signed-in" ? result.defaultValues.email : "").toBe("seller@example.com");
    expect(result.mode === "signed-in" ? result.defaultValues.shipFromLine1 : "").toBe("100 Market Street");
    expect(result.mode === "signed-in" ? result.payoutSummary?.status : "").toBe("ready");
    expect(result.mode === "signed-in" ? result.reviewPlan : null).toEqual(readySellListReadinessResponse().reviewPlan);
  });

  it("fails signed-in seller checkout closed when Sell List readiness is stale", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateSellListReadiness.mockResolvedValue({
      ...readySellListReadinessResponse(),
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

  function mockStoredReview(
    plan: SellListReviewPlan,
    decisions: SellListReadinessDecisionInput = readySellListReadinessResponse().decisions,
  ) {
    const prior = mockCreateSellListReadiness.getMockImplementation();
    mockCreateSellListReadiness.mockImplementation(async (...args) => ({
      ...(await prior?.(...args)),
      reviewPlan: plan,
      decisions,
    }));
  }

  function signedInSellCheckoutForm(overrides: Record<string, string> = {}) {
    const { storedReviewPlan, storedReadinessDecisions, ...fields } = overrides;
    mockStoredReview(
      storedReviewPlan ? JSON.parse(storedReviewPlan) : readySellListReadinessResponse().reviewPlan,
      storedReadinessDecisions ? JSON.parse(storedReadinessDecisions) : readySellListReadinessResponse().decisions,
    );
    const form = new URLSearchParams({
      readinessSnapshotId: "slr_ready",
      readinessSourceRevision: "slr_source",
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
      ...fields,
    });
    return form;
  }

  const mockRemoveSellListLine = vi.fn();

  function mockSignedInSellCheckoutState(lineOverrides: Parameters<typeof guestSellListLine>[0] = {}) {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInSellerActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [guestSellListLine({ seller_account_id: "acc_seller", ...lineOverrides })],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      removeSellListLine: mockRemoveSellListLine,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
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

  it("pins both two-member Smart Match receipts on the committed Sales link", async () => {
    mockSignedInSellCheckoutState({
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      offer_price_amount: null,
      quantity: 2,
      minimum_listing_price_amount: null,
    });
    mockCreateSellListReadiness.mockResolvedValue({
      ...readySellListReadinessResponse(),
      readiness: {
        ...readySellListReadinessResponse().readiness,
        lineCount: 1,
        includedLineIds: ["sll_product"],
        lineOutcomes: [{ lineId: "sll_product", outcome: "checkout", reason: "ready", action: "smart-match" }],
      },
    });
    for (const [index, eventId] of ["first_member", "completing_member"].entries()) {
      mockAcceptOfferMatch.mockResolvedValueOnce({
        status: "accepted",
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: String(55 + index),
            eventIds: [eventId],
          },
        ],
      });
    }
    const targets = [1, 2].map((index) => ({
      offerId: `off_product_${index}`,
      listingId: `lst_product_${index}`,
      feeQuoteFingerprint: `quote_product_${index}`,
      quantity: 1,
    }));
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          storedReadinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "smart-match" }],
            lineOutcomes: [],
          }),
          storedReviewPlan: JSON.stringify({
            version: 1,
            lines: [
              {
                lineId: "sll_product",
                lineType: "product",
                itemTitle: "Mewtwo",
                productId: "prod_1",
                quantity: 2,
                selectedOffer: null,
                productOfferTargets: targets,
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
    expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(2);
    for (const target of targets)
      expect(mockAcceptOfferMatch).toHaveBeenCalledWith(
        target.offerId,
        expect.objectContaining({
          acceptanceBatchId: "offer-acceptance:slc_chk_sell_1:sll_product",
          acceptanceBatchSize: 2,
        }),
      );
    mockGetSellListConfirmation.mockResolvedValue({ confirmation_id: "slc_chk_sell_1" });
    const confirmation = await sellCheckoutConfirmationLoader({
      request: new Request(new URL((result as Response).headers.get("Location")!, "http://localhost")),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    expect(confirmation.committedSalesPath).toContain("/account/sales?");
    expect(
      await readResolvedFreshWriteToken(new URL(confirmation.committedSalesPath, "http://localhost")),
    ).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          sourceContextName: "marketplace",
          maxGlobalPosition: "56",
          eventIds: ["first_member", "completing_member"],
        }),
      ]),
    });
  });

  it("renders another acceptance as a conflict, never this line's completion", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockRejectedValueOnce(
      new MockMarketplaceApiError(409, { error: { code: "offer_already_accepted" } }),
    );

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      status: "error",
      attempt: { state: "partial", lines: [{ id: "sll_1", status: "conflict" }] },
    });
    expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(1);
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  });

  it.each(["managed_offer_held", "managed_offer_refresh_required", "managed_offer_conflict"])(
    "requires fresh seller review for %s without retrying a stale confirmation",
    async (code) => {
      mockSignedInSellCheckoutState();
      mockAcceptOfferMatch.mockRejectedValueOnce(new MockMarketplaceApiError(409, { error: { code } }));
      const result = await sellCheckoutSessionAction({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: signedInSellCheckoutForm().toString(),
        }),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never);
      expect(result).toMatchObject({ status: "error", recovery: { kind: "readiness-stale" } });
      const detail =
        "Acerola's Mischief: this Offer needs current pricing terms. Refresh the Match and review price, fees and evidence. Your Sell List selection was kept.";
      expect(result).toMatchObject({ fieldErrors: { form: detail }, recovery: { detail } });
      expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(1);
      expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
      expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
      expect(mockRemoveSellListLine).not.toHaveBeenCalled();
      expect(mockRemoveGuestSellListLine).not.toHaveBeenCalled();
      for (const key of [
        "buyerOfferPolicyId",
        "buyer_offer_policy_id",
        "authority",
        "preview",
        "maximumUnitItemAmount",
        "adjustmentBps",
        "itemCommitmentAllowance",
        "consumedItemAmount",
        "remainingItemAllowance",
      ])
        expect(JSON.stringify(result)).not.toContain(`"${key}"`);
    },
  );

  it("turns offer_not_open from a paused or withdrawn Offer into Sell List re-review", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockRejectedValueOnce(
      new MockMarketplaceApiError(409, { error: { code: "offer_not_open", details: { status: "paused" } } }),
    );
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    const detail = "Acerola's Mischief: offer terms need refresh.";
    expect(result).toMatchObject({
      status: "error",
      fieldErrors: { form: detail },
      recovery: { kind: "readiness-stale", detail },
    });
    expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(1);
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
    expect(mockRemoveSellListLine).not.toHaveBeenCalled();
  });

  it("keeps the generic refresh message for fee_quote_stale", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockRejectedValueOnce(
      new MockMarketplaceApiError(409, { error: { code: "fee_quote_stale" } }),
    );
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    const detail = "Acerola's Mischief: offer terms need refresh.";
    expect(result).toMatchObject({
      status: "error",
      fieldErrors: { form: detail },
      recovery: { kind: "readiness-stale", detail },
    });
    expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(1);
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
    expect(mockRemoveSellListLine).not.toHaveBeenCalled();
  });

  it("surfaces a re-review recovery when Marketplace reports incomplete Listing Evidence at acceptance", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockRejectedValueOnce(
      new MockMarketplaceApiError(409, { error: { code: "listing_evidence_incomplete" } }),
    );

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm().toString(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      status: "error",
      recovery: { kind: "readiness-stale" },
    });
    expect(mockAcceptOfferMatch).toHaveBeenCalledTimes(1);
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
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

  it("a successful same-seller response and an unrelated receipt do not prove this line consumed its acceptance key", async () => {
    mockSignedInSellCheckoutState();
    mockAcceptOfferMatch.mockResolvedValue({
      id: "off_1",
      version: 2,
      commandReceipt: {
        commitPositions: [{ sourceContextName: "marketplace", maxGlobalPosition: "88", eventIds: ["evt_unrelated"] }],
      },
    });
    mockGetOfferAcceptanceAttempt.mockResolvedValue({
      schemaVersion: 1,
      mutationKind: "offer.accept",
      ownerStatus: "not-observed",
      actorBinding: { accountId: "acc_seller" },
      target: { kind: "offer", id: "off_1" },
      attemptKeyFingerprint: "a".repeat(64),
      canonicalRequestHash: "b".repeat(64),
    });
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        body: signedInSellCheckoutForm(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    expect(result).toMatchObject({ attempt: { state: "partial", lines: [{ id: "sll_1", status: "conflict" }] } });
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
    expect(mockGetOfferAcceptanceAttempt).toHaveBeenCalledExactlyOnceWith(
      "off_1",
      expect.objectContaining({ sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1" }),
    );
  });

  it.each([
    { actorBinding: { accountId: "acc_other" } },
    { target: { kind: "offer", id: "off_other" } },
    { attemptKeyFingerprint: "c".repeat(64) },
    { canonicalRequestHash: "d".repeat(64) },
    { ownerReceipt: { id: "off_other", version: 2 } },
  ])("refuses acceptance proof with a foreign owner, target, key, hash or receipt: %j", async (changed) => {
    mockSignedInSellCheckoutState();
    const proof = await mockGetOfferAcceptanceAttempt("off_1", {
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
    });
    mockGetOfferAcceptanceAttempt.mockResolvedValue({ ...proof, ...changed });
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        body: signedInSellCheckoutForm(),
      }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    expect(result).toMatchObject({ attempt: { state: "partial", lines: [{ id: "sll_1", status: "conflict" }] } });
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("reads Marketplace's closed acceptance attempt over the existing owner lookup, with the canonical request hash", async () => {
    const actual = await vi.importActual<typeof import("@chase-sets/marketplace/server")>(
      "@chase-sets/marketplace/server",
    );
    const body = {
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
    };
    const expected = await mockGetOfferAcceptanceAttempt("off_1", body);
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(expected));
    const client = actual.createMarketplaceApiClient({ baseUrl: "http://localhost/api/marketplace", fetch: transport });
    expect(await client.getOfferAcceptanceAttempt("off_1", body)).toEqual(expected);
    expect(transport).toHaveBeenCalledOnce();
    const url = new URL(String(transport.mock.calls[0][0]));
    expect(url.pathname).toContain(encodeURIComponent(body.sourceActionKey));
    expect(url.searchParams.get("requestHash")).toBe(expected.canonicalRequestHash);
    expect(url.searchParams.get("kind")).toBe("offer.accept");
  });
  it("a lost acceptance uses its one Marketplace owner read as consumed-key proof, never a second lookup or resend", async () => {
    const actual = await vi.importActual<typeof import("@chase-sets/marketplace/server")>(
      "@chase-sets/marketplace/server",
    );
    const body = {
      sourceActionKey: "sell-confirm:slc_chk_sell_1:sll_1:selected:off_1",
      listingId: "lst_1",
      feeQuoteFingerprint: "quote_1",
    };
    const expected = await mockGetOfferAcceptanceAttempt("off_1", body);
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("synthetic acknowledgement loss");
      return Response.json(expected);
    });
    const client = actual.createMarketplaceApiClient({ baseUrl: "http://localhost/api/marketplace", fetch: transport });
    expect(await client.acceptOfferMatch("off_1", body)).toEqual(expected.ownerReceipt);
    expect(await client.getOfferAcceptanceAttempt("off_1", body)).toEqual(expected);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("loss after k of n acceptances renders partial; explicit retry replays first receipts and day-after confirmed fallback never republishes a paused Listing", async () => {
    mockSignedInSellCheckoutState();
    const api = mockCreateCheckoutRequestApiClient();
    const lines = [
      guestSellListLine({ seller_account_id: "acc_seller" }),
      guestSellListLine({ seller_account_id: "acc_seller", line_id: "sll_2", offer_id: "off_2", listing_id: "lst_2" }),
      guestSellListLine({
        seller_account_id: "acc_seller",
        line_id: "sll_fallback",
        line_type: "product",
        offer_id: null,
        listing_id: null,
        fallback_mode: "create-listing",
      }),
    ];
    api.getSellList.mockResolvedValue({ items: lines, count: 3 });
    const readiness = readySellListReadinessResponse().readiness;
    mockCreateSellListReadiness.mockResolvedValue({
      ...readySellListReadinessResponse(),
      readiness: {
        ...readiness,
        includedLineIds: lines.map((line) => line.line_id),
        lineOutcomes: lines.map((line) => ({
          lineId: line.line_id,
          outcome: "checkout",
          reason: "ready",
          action: line.line_type === "product" ? "fallback-listing" : "selected-offer",
        })),
      },
    });
    const form = signedInSellCheckoutForm();
    const plan = structuredClone(readySellListReadinessResponse().reviewPlan) as {
      version: 1;
      lines: SellListReviewPlan["lines"][number][];
    };
    plan.lines.push(
      {
        ...plan.lines[0],
        lineId: "sll_2",
        selectedOffer: { offerId: "off_2", listingId: "lst_2", feeQuoteFingerprint: "quote_2" },
      },
      {
        ...plan.lines[0],
        lineId: "sll_fallback",
        lineType: "product",
        selectedOffer: null,
        fallbackListing: {
          inventoryItemId: "inv_fallback",
          priceAmount: "40.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        },
      },
    );
    mockStoredReview(plan, {
      lineActions: lines.map((line) => ({
        lineId: line.line_id,
        action: line.line_type === "product" ? "fallback-listing" : "selected-offer",
      })),
      lineOutcomes: [],
    });
    const receipts = new Map<string, { id: string; version: number }>();
    const writes: string[] = [];
    let lose = true;
    mockAcceptOfferMatch.mockImplementation(async (id, body) => {
      if (!receipts.has(body.sourceActionKey)) {
        writes.push(id);
        receipts.set(body.sourceActionKey, { id, version: 2 });
      }
      if (id === "off_2" && lose) {
        lose = false;
        throw new TypeError("synthetic lost acceptance acknowledgement and unresolved lookup");
      }
      return receipts.get(body.sourceActionKey);
    });
    const post = () =>
      sellCheckoutSessionAction({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1", { method: "POST", body: form }),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never);
    expect(await post()).toMatchObject({
      status: "error",
      attempt: {
        state: "partial",
        lines: [
          { id: "sll_1", status: "completed" },
          { id: "sll_2", status: "ambiguous" },
          { id: "sll_fallback", status: "not-attempted" },
        ],
      },
    });
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
    expect(writes).toEqual(["off_1", "off_2"]);
    const firstReceipt = receipts.get("sell-confirm:slc_chk_sell_1:sll_1:selected:off_1");
    mockCreateListing.mockResolvedValue({ id: "lst_fallback", feeQuoteFingerprint: "fallback_quote" });
    mockPublishListing.mockResolvedValue({ id: "lst_fallback", version: 2 });
    await expectSellConfirmationRedirect(await post());
    expect(writes).toEqual(["off_1", "off_2"]);
    expect(await mockAcceptOfferMatch.mock.results[2].value).toBe(firstReceipt);
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
    expect(mockCreateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        listingIdOverride: "lst_slc_chk_sell_1_sll_fallback",
      }),
    );
    const marketplaceCalls = [
      mockAcceptOfferMatch.mock.calls.length,
      mockCreateListing.mock.calls.length,
      mockPublishListing.mock.calls.length,
    ];
    const confirmBody = mockConfirmSellListCheckout.mock.calls[0][0];
    mockGetSellListConfirmation.mockResolvedValue({
      confirmation_id: confirmBody.confirmationId,
      handoff_summary: confirmBody.handoffSummary,
    });
    api.getSellList.mockRejectedValue(new Error("day-after list unavailable"));
    mockPublishListing.mockRejectedValue(new MockMarketplaceApiError(409, { error: { code: "listing_paused" } }));
    await expectSellConfirmationRedirect(await post(), { freshWrite: "absent" });
    expect([
      mockAcceptOfferMatch.mock.calls.length,
      mockCreateListing.mock.calls.length,
      mockPublishListing.mock.calls.length,
    ]).toEqual(marketplaceCalls);
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
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
    ).resolves.toMatchObject({ status: "error", attempt: { state: "ambiguous" } });

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

  it("rejects inconsistent stored fallback listing facts before side effects", async () => {
    mockSignedInSellCheckoutState();

    const form = signedInSellCheckoutForm({
      storedReviewPlan: JSON.stringify({
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
            fallbackListing: {
              inventoryItemId: "inv_extra",
              priceAmount: "40.00",
              priceCurrencyCode: "USD",
              quantityCap: 1,
            },
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
      ...readySellListReadinessResponse(),
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
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          storedReadinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "fallback-listing" }],
            lineOutcomes: [],
          }),
          storedReviewPlan: JSON.stringify({
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
                fallbackListing: {
                  inventoryItemId: "inv_1",
                  priceAmount: "12.00",
                  priceCurrencyCode: "USD",
                  quantityCap: 1,
                },
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
      idempotencyKey: "2e4bc1139f2861897100cf5ba6be36bf3bd4274891e7343eb89496c72f6c1160",
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockPublishListing).toHaveBeenCalledWith("lst_slc_chk_sell_1_sll_1", {
      idempotencyKey: "1ba4296cdaed440502c5a4d940095ab8606746d838dccee9c3108340b1814913",
      feeQuoteFingerprint: "listing_quote_1",
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
      ...readySellListReadinessResponse(),
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
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: signedInSellCheckoutForm({
          storedReadinessDecisions: JSON.stringify({
            lineActions: [{ lineId: "sll_product", action: "smart-match" }],
            lineOutcomes: [],
          }),
          storedReviewPlan: JSON.stringify({
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
      ...readySellListReadinessResponse(),
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
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      storedReadinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      storedReviewPlan: JSON.stringify({
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
            fallbackListing: {
              inventoryItemId: "inv_1",
              priceAmount: "12.00",
              priceCurrencyCode: "USD",
              quantityCap: 1,
            },
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
      idempotencyKey: "2e4bc1139f2861897100cf5ba6be36bf3bd4274891e7343eb89496c72f6c1160",
      inventoryItemId: "inv_1",
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      quantityCap: 1,
      listingIdOverride: "lst_slc_chk_sell_1_sll_product",
    });
    expect(mockPublishListing).toHaveBeenCalledWith("lst_slc_chk_sell_1_sll_product", {
      idempotencyKey: "1ba4296cdaed440502c5a4d940095ab8606746d838dccee9c3108340b1814913",
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
      ...readySellListReadinessResponse(),
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
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
      createListing: mockCreateListing,
      publishListing: mockPublishListing,
    });

    const form = signedInSellCheckoutForm({
      storedReadinessDecisions: JSON.stringify({
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
        lineOutcomes: [],
      }),
      storedReviewPlan: JSON.stringify({
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

  it("stored review plan survives reload and preparation", async () => {
    mockSignedInSellCheckoutState();
    const first = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl()),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    const second = await sellCheckoutSessionLoader({
      request: new Request(signedInSellCheckoutUrl({ sellListReviewPlan: '{"version":1,"lines":[]}' })),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    expect(first.mode === "signed-in" ? first.reviewPlan : null).toEqual(readySellListReadinessResponse().reviewPlan);
    expect(second).toEqual(first);
    const form = signedInSellCheckoutForm();
    expect(form.has("sellListReviewPlan")).toBe(false);
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", { method: "POST", body: form }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    await expectSellConfirmationRedirect(result);
    expect(mockCreateSellListReadiness).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entryReadinessSnapshotId: "slr_ready",
        entryReadinessSourceRevision: "slr_source",
      }),
    );
    expect(mockCreateSellListReadiness.mock.calls.at(-1)![0]).not.toHaveProperty("reviewPlan");
    expect(mockAcceptOfferMatch).toHaveBeenCalledWith("off_1", expect.objectContaining({ listingId: "lst_1" }));
  });

  it.each(["missing", "foreign", "stale", "mismatched"])(
    "stale or foreign review plan refuses before handoff: %s",
    async () => {
      mockSignedInSellCheckoutState();
      const form = signedInSellCheckoutForm();
      mockCreateSellListReadiness.mockRejectedValue(
        new MockCheckoutApiError(400, {
          error: { code: "checkout_readiness_stale" },
        }),
      );
      const result = await sellCheckoutSessionAction({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1", { method: "POST", body: form }),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never);
      expect(result).toMatchObject({ status: "error", recovery: { kind: "readiness-stale" } });
      expectNoSellerCommitSideEffects();
    },
  );

  it("posted review plan cannot change confirmation", async () => {
    mockSignedInSellCheckoutState();
    const form = signedInSellCheckoutForm();
    form.set(
      "sellListReviewPlan",
      JSON.stringify({
        version: 1,
        lines: [{ lineId: "sll_1", selectedOffer: { offerId: "off_attacker", listingId: "lst_attacker" } }],
      }),
    );
    form.set("readinessDecisions", JSON.stringify({ lineActions: [], lineOutcomes: [] }));
    const post = () =>
      sellCheckoutSessionAction({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1", { method: "POST", body: form }),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never);
    await expectSellConfirmationRedirect(await post());
    expect(mockAcceptOfferMatch).toHaveBeenCalledExactlyOnceWith(
      "off_1",
      expect.objectContaining({
        listingId: "lst_1",
        feeQuoteFingerprint: "quote_1",
      }),
    );
    expect(mockConfirmSellListCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        readinessDecisions: readySellListReadinessResponse().decisions,
      }),
    );
    mockGetSellListConfirmation.mockResolvedValue({ confirmation_id: "slc_chk_sell_1" });
    await expectSellConfirmationRedirect(await post(), { freshWrite: "absent" });
    expect(mockAcceptOfferMatch).toHaveBeenCalledOnce();
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
  });
  it("recovers a review that becomes stale during preparation before handoff", async () => {
    mockSignedInSellCheckoutState();
    const form = signedInSellCheckoutForm();
    const stored = readySellListReadinessResponse();
    mockCreateSellListReadiness
      .mockResolvedValueOnce(stored)
      .mockRejectedValueOnce(new MockCheckoutApiError(400, { error: { code: "checkout_readiness_stale" } }));
    const result = await sellCheckoutSessionAction({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1", { method: "POST", body: form }),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);
    expect(result).toMatchObject({ status: "error", recovery: { kind: "readiness-stale" } });
    expectNoSellerCommitSideEffects();
  });
});
