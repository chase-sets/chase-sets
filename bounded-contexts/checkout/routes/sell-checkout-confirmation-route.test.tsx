// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { appendFreshWriteToken, readCompactPostWriteToken } from "@chase-sets/http/responses";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  MockCheckoutApiError,
  mockCreateCheckoutRequestApiClient,
  mockGetSellListConfirmation,
  mockResolveActorFromAuthApi,
  guestSellListLine,
  mockAcceptOfferMatch,
  mockGetOfferAcceptanceAttempt,
  mockConfirmSellListCheckout,
  mockCreateMarketplaceRequestApiClient,
  mockCreateSellListReadiness,
  mockGetPayoutReadiness,
  mockListSellListShipFromAddresses,
  MockMarketplaceApiError,
} from "../tests/support/checkout-route-test-harness";

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    resolveActorFromAuthApi: mockResolveActorFromAuthApi,
  };
});

vi.mock("../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../support/request-support/api-client")>(
    "../support/request-support/api-client",
  );

  return {
    ...actual,
    CheckoutApiError: MockCheckoutApiError,
    createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  };
});

vi.mock("@chase-sets/marketplace/server", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/marketplace/server")>("@chase-sets/marketplace/server")),
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  MarketplaceApiError: MockMarketplaceApiError,
}));
import ConfirmationRoute, {
  loader as sellCheckoutConfirmationLoader,
  HydrateFallback,
  ErrorBoundary,
} from "./sell-checkout-confirmation";
import SessionRoute, { action as sessionAction, loader as sessionLoader } from "./sell-checkout-session";

function confirmationRow() {
  return {
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
  };
}

describe("checkout web routes: sell checkout confirmation loader", () => {
  let router: ReturnType<typeof createMemoryRouter> | undefined;
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    cleanup();
    router?.dispose();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  async function settle() {
    if (router!.state.initialized && router!.state.navigation.state === "idle") return;
    await new Promise<void>((resolve) => {
      const unsubscribe = router!.subscribe((state) => {
        if (state.initialized && state.navigation.state === "idle") {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  function start(path: string) {
    router = createMemoryRouter(
      [
        {
          path: "/checkout/sell/session/:sessionId",
          Component: SessionRoute,
          action: sessionAction,
          loader: sessionLoader,
        },
        {
          path: "/checkout/sell/session/:sessionId/confirmation",
          Component: ConfirmationRoute,
          loader: sellCheckoutConfirmationLoader,
          HydrateFallback,
          ErrorBoundary,
        },
      ],
      { initialEntries: [path] },
    );
    render(<RouterProvider router={router} />);
  }
  async function mount(path: string) {
    start(path);
    await act(settle);
  }
  function sellerSession() {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: ["accounts.view"] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi
        .fn()
        .mockResolvedValue({ items: [guestSellListLine({ seller_account_id: "acc_seller" })], count: 1 }),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListConfirmation: mockGetSellListConfirmation,
      confirmSellListCheckout: mockConfirmSellListCheckout,
      getSellListPayoutReadiness: mockGetPayoutReadiness,
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      getOfferAcceptanceAttempt: mockGetOfferAcceptanceAttempt,
    });
    return new URLSearchParams({
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
            itemTitle: "Synthetic sale",
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
      shipFromLine1: "100 Market St",
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
    });
  }
  const sessionPath = "/checkout/sell/session/chk_sell_1";
  async function postSession(fields: URLSearchParams) {
    const formData = new FormData();
    for (const [name, value] of fields) formData.append(name, value);
    await router!.navigate(`${sessionPath}${router!.state.location.search}`, { formMethod: "post", formData });
  }

  it("real session router refuses invalid input before any command, not injected action props", async () => {
    const fields = sellerSession();
    await mount(`${sessionPath}?${fields}`);
    fields.delete("termsAccepted");
    await act(async () => {
      await postSession(fields);
    });
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
    expect(router!.state.actionData).toMatchObject({
      "0": { status: "error", fieldErrors: { termsAccepted: expect.any(String) } },
    });
  });

  it("real session router keeps confirming for the single confirmation lookup after loss, then announces and focuses ambiguous without resend", async () => {
    const fields = sellerSession();
    await mount(`${sessionPath}?${fields}`);
    let finish!: () => void;
    mockConfirmSellListCheckout.mockRejectedValue(new TypeError("synthetic response loss"));
    mockGetSellListConfirmation.mockRejectedValueOnce(new MockCheckoutApiError(404, {})).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          finish = () => reject(new TypeError("synthetic lookup loss"));
        }),
    );
    let submission!: Promise<void>;
    await act(async () => {
      submission = postSession(fields);
    });
    await waitFor(() => expect(mockGetSellListConfirmation).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toContain("Confirming");
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
    expect(mockGetSellListConfirmation).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish();
      await submission;
    });
    const notice = screen
      .getAllByRole("alert")
      .find((element) => element.textContent?.includes("could not be confirmed"))!;
    expect(document.activeElement).toBe(notice.parentElement);
    expect(screen.getAllByRole("group").some((element) => element.hasAttribute("disabled"))).toBe(true);
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
    expect(mockCreateMarketplaceRequestApiClient).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  });

  it("real session router lists the API's foreign acceptance conflict without web Marketplace writes", async () => {
    const fields = sellerSession();
    await mount(`${sessionPath}?${fields}`);
    mockConfirmSellListCheckout.mockRejectedValue(
      new MockCheckoutApiError(409, {
        error: {
          code: "checkout_handoff_interrupted",
          message: "Offer already accepted.",
          lines: [{ lineId: "sll_1", status: "conflict", detail: "Offer already accepted." }],
        },
      }),
    );
    await act(async () => {
      await postSession(fields);
    });
    expect(screen.getByText("sll_1: conflict")).toBeTruthy();
    expect(mockConfirmSellListCheckout).toHaveBeenCalledOnce();
    expect(mockCreateMarketplaceRequestApiClient).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
  });

  it("real confirmation router announces pending, converges to the first snapshot, and performs no command", async () => {
    sellerSession();
    let finish!: (value: ReturnType<typeof confirmationRow>) => void;
    mockGetSellListConfirmation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    start(`${sessionPath}/confirmation`);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toContain("Confirming");
    await act(async () => {
      finish(confirmationRow());
      await settle();
    });
    expect(router!.state.loaderData["1"].confirmation).toEqual(confirmationRow());
    expect(mockGetSellListConfirmation).toHaveBeenCalledOnce();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("real confirmation router preserves an unknown owner read as focused ambiguous with a read-only retry", async () => {
    sellerSession();
    mockGetSellListConfirmation.mockRejectedValue(new TypeError("synthetic lookup loss"));
    await mount(`${sessionPath}/confirmation`);
    expect(screen.getByRole("alert").textContent).toContain("could not be confirmed");
    expect(document.activeElement).toBe(screen.getByRole("alert").parentElement);
    expect(screen.getByRole("link", { name: "Retry the same action" }).getAttribute("href")).toBe(
      `${sessionPath}/confirmation`,
    );
    expect(mockGetSellListConfirmation).toHaveBeenCalledOnce();
    expect(mockConfirmSellListCheckout).not.toHaveBeenCalled();
  });

  it("routes guests through seller registration before showing a seller confirmation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const redirectResponse = (await sellCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1/confirmation"),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get("Location")).toBe(
      "/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
    expect(mockGetSellListConfirmation).not.toHaveBeenCalled();
  });

  it("loads signed-in seller confirmation from the derived session confirmation reference", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation.mockResolvedValue(confirmationRow());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const result = await sellCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1/confirmation"),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(mockGetSellListConfirmation).toHaveBeenCalledWith("slc_chk_sell_1");
    expect(result).toEqual({
      confirmation: expect.objectContaining({
        confirmation_id: "slc_chk_sell_1",
      }),
      sellerActivityPath: "/account/sell-list",
      committedSalesPath: "/account/sales",
    });
  });

  it("retries a freshly written seller confirmation while the confirmation projection catches up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation
      .mockRejectedValueOnce(new MockCheckoutApiError(404, { error: { code: "not_found" } }))
      .mockResolvedValueOnce(confirmationRow());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const requestPath = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("42", "evt_checkout_sell_list_confirmed"),
      "/checkout/sell/session/chk_sell_1/confirmation",
    );

    const result = await sellCheckoutConfirmationLoader({
      request: new Request(`http://localhost${requestPath}`),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    expect(mockGetSellListConfirmation).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      confirmation: expect.objectContaining({
        confirmation_id: "slc_chk_sell_1",
      }),
      sellerActivityPath: expect.stringContaining("/account/sell-list?postWriteToken="),
      committedSalesPath: expect.stringContaining("/account/sales?postWriteToken="),
    });
    expect(result.sellerActivityPath).not.toContain("afterWrite=");
    expect(result.committedSalesPath).not.toContain("afterWrite=");
  });

  it("preserves seller checkout freshness on confirmation page exit links", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation.mockResolvedValue(confirmationRow());
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const requestPath = appendFreshWriteToken(
      "/checkout/sell/session/chk_sell_1/confirmation",
      checkoutCommit("42", "evt_checkout_sell_list_confirmed"),
    );

    const result = await sellCheckoutConfirmationLoader({
      request: new Request(`http://localhost${requestPath}`),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never);

    const originalAfterWrite = new URL(requestPath, "http://localhost").searchParams.get("afterWrite");
    expect(new URL(result.sellerActivityPath, "http://localhost").searchParams.get("afterWrite")).toBe(
      originalAfterWrite,
    );
    expect(new URL(result.committedSalesPath, "http://localhost").searchParams.get("afterWrite")).toBe(
      originalAfterWrite,
    );
  });

  it("returns to Sell List preparation when a freshly written seller confirmation is still catching up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation.mockRejectedValue(new MockCheckoutApiError(404, { error: { code: "not_found" } }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const requestPath = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("42", "evt_checkout_sell_list_confirmed"),
      "/checkout/sell/session/chk_sell_1/confirmation",
      { nowMs: Date.now() - 1 },
    );

    const redirectResponse = (await sellCheckoutConfirmationLoader({
      request: new Request(`http://localhost${requestPath}`),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    const location = redirectResponse.headers.get("Location") ?? "";
    const url = new URL(location, "http://localhost");
    expect(redirectResponse.status).toBe(302);
    expect(url.pathname).toBe("/account/sell-list");
    expect(url.searchParams.get("confirmation")).toBe("preparing");
    expect(url.searchParams.get("pendingConfirmationId")).toBe("slc_chk_sell_1");
    expect(readCompactPostWriteToken(url)).toMatch(/^pwt_/);
    expect(url.searchParams.has("afterWrite")).toBe(false);
  });

  it("returns missing confirmation links to Sell List without side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation.mockRejectedValue(new MockCheckoutApiError(404, { error: { code: "not_found" } }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    const redirectResponse = (await sellCheckoutConfirmationLoader({
      request: new Request("http://localhost/checkout/sell/session/chk_sell_1/confirmation"),
      params: { sessionId: "chk_sell_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get("Location")).toBe("/account/sell-list?confirmation=missing");
  });

  it("does not hide non-404 confirmation lookup failures", async () => {
    const failure = new MockCheckoutApiError(503, { error: { code: "checkout_unavailable" } });
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetSellListConfirmation.mockRejectedValue(failure);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellListConfirmation: mockGetSellListConfirmation,
    });

    await expect(
      sellCheckoutConfirmationLoader({
        request: new Request("http://localhost/checkout/sell/session/chk_sell_1/confirmation"),
        params: { sessionId: "chk_sell_1" },
        context: undefined,
      } as never),
    ).rejects.toBe(failure);
  });
});
