import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, readCompactPostWriteToken } from "@chase-sets/http/responses";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  MockCheckoutApiError,
  mockCreateCheckoutRequestApiClient,
  mockGetSellListConfirmation,
  mockResolveActorFromAuthApi,
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

import { loader as sellCheckoutConfirmationLoader } from "./sell-checkout-confirmation";

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
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
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
