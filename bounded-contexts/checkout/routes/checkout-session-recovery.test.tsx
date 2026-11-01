// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../support/request-support/api-client";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  MockCheckoutApiError,
  mockConfirmCheckoutSession,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockListSellListShipFromAddresses,
  mockMergeGuestCartToAccount,
  mockRecordFulfillmentPreview,
  mockResolveActorFromAuthApi,
  mockSelectAuthenticityCheckOptIn,
  mockSelectShippingAddress,
  mockSelectShippingOption,
} from "../tests/support/checkout-route-test-harness";
import {
  checkoutEntryPayload,
  computeCheckoutEntryRequestHash,
} from "../features/command-attempts/api/entry-attempt-contracts";

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );
  return { ...actual, resolveActorFromAuthApi: mockResolveActorFromAuthApi };
});

vi.mock("@chase-sets/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth/server")>("@chase-sets/auth/server");
  return { ...actual, createAuthRequestApiClient: mockCreateAuthRequestApiClient };
});

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");
  return { ...actual, createIdentityRequestApiClient: mockCreateIdentityRequestApiClient };
});

vi.mock("../support/request-support/api-client", () => ({
  CheckoutApiError: MockCheckoutApiError,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

vi.mock("@chase-sets/ordering/server", () => ({ createOrderingRequestApiClient: mockCreateOrderingRequestApiClient }));
vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
}));
vi.mock("@chase-sets/payments/web", () => ({ StripeConfirmationCard: () => null }));
vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  subscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

import CheckoutSessionRoute, { action as sessionAction, loader as sessionLoader } from "./checkout-session";
import CheckoutStartRoute, { action as startAction, loader as startLoader } from "./checkout-start";

const mockGetCheckoutEntryAttempt = vi.fn();

const shippingAddress = {
  shippingAddressId: "adr_home" as const,
  name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "312-555-0199",
  email: "jane@example.com",
};

const fulfillmentPreview: CheckoutFulfillmentPreview = {
  revision: "rev_1",
  optimizationGoal: "lowest-total",
  readyLineKeys: ["line_1"],
  unavailableLineKeys: [],
  unavailableLines: [],
  materialChangeReasons: [],
  sellerGroups: [
    {
      sellerAccountId: "seller_1",
      sellerDisplayName: "Card Vault",
      itemSubtotalAmount: "20.00",
      shippingChargeAmount: "4.00",
      salesTaxAmount: "2.00",
      totalAmount: "26.00",
      postageRequirements: {
        policyVersion: "operator-postage-v1",
        parcelRequired: false,
        parcelReasons: [],
        signatureRequired: false,
        signatureReasons: [],
        insuranceRequired: false,
        insuranceReasons: [],
        insuredValueAmount: null,
        shippingEvidenceTier: "standard",
      },
      deliveryEstimate: {
        earliestDate: "2026-10-30",
        latestDate: "2026-11-03",
        minimumTransitDays: 2,
        maximumTransitDays: 4,
        handlingDays: 1,
        packageCount: 1,
        shipFromRegion: "Chicago, IL",
        serviceLevel: "standard parcel",
        promiseOwner: "fulfillment",
        promiseSource: "fulfillment-promise-policy",
        promiseConfidence: "estimated",
        cutoffTimeLocal: "16:00",
        packingStartDate: "2026-10-28",
        carrierHandoffDate: "2026-10-29",
        basis: "standard parcel",
      },
      lines: [
        {
          lineKey: "line_1",
          listingId: "listing_1",
          sellerAccountId: "seller_1",
          inventoryItemId: "inventory_1",
          catalogItemId: "catalog_1",
          productId: "product_1",
          itemTitle: "Test card",
          productSummary: "Raw",
          quantity: 1,
          estimatedUnitPriceAmount: "20.00",
          estimatedLineTotalAmount: "20.00",
          priceState: "available",
          materialChangeReasons: [],
        },
      ],
    },
  ],
  totals: {
    itemSubtotalAmount: "20.00",
    shippingAmount: "4.00",
    salesTaxAmount: "2.00",
    totalAmount: "26.00",
    packageCount: 1,
  },
};

function checkoutSession(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    session_id: "chk_recovery",
    buyer_account_id: "acc_buyer",
    source_type: "buy-now",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: "rev_1",
    fulfillment_preview_snapshot: fulfillmentPreview,
    shipping_option: "standard",
    shipping_address_id: "adr_home",
    shipping_address: shippingAddress,
    authenticity_check_opt_in: null,
    lines: [
      {
        listingId: "listing_1",
        cartLineId: null,
        catalogItemId: "catalog_1",
        productId: "product_1",
        itemTitle: "Test card",
        itemSubtitle: "Raw",
        selectedOptions: [],
        productSummary: "Raw",
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: null,
        sellerPreferenceId: null,
        availabilityState: "available",
      },
    ],
    order_ids: [],
    order_write_commit_positions: [],
    checkout_reservations: [],
    payment_id: null,
    submitted_offer_id: null,
    handoff_expires_at: null,
    created_at: "2026-10-28T00:00:00.000Z",
    updated_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

const signedInActor = { accountId: "acc_buyer", roleKey: "owner", permissions: ["orders.view", "payouts.view"] };
const sessionPath = "/checkout/buy/session/chk_recovery";
const startPath =
  "/checkout/buy/readiness?source=buy-now&listingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=2&fulfillmentMode=locked-listing&lockedListingId=lst_1";

let router: ReturnType<typeof createMemoryRouter> | undefined;
let unmount: (() => void) | undefined;
/** Every Checkout API call in order, tagged with the HTTP method of the route request that made it. */
let apiLog: string[] = [];
let currentSession = checkoutSession();

/**
 * One Checkout client per route request, as production builds them. Loader
 * reads come from GET requests and action calls from the POST, so the log
 * shows exactly what the action sent after a possible-send loss.
 */
function routeApi() {
  mockCreateCheckoutRequestApiClient.mockImplementation((request: Request) => {
    const logged =
      (name: string, call: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        apiLog.push(`${request.method} ${name}`);
        return call(...args);
      };
    return {
      getCheckoutSession: logged("getCheckoutSession", async () => currentSession),
      getCheckoutPaymentConfirmation: logged("getCheckoutPaymentConfirmation", async () => null),
      listSellListShipFromAddresses: mockListSellListShipFromAddresses,
      listCheckoutSavedPaymentInstruments: vi.fn(async () => ({ items: [] })),
      selectShippingOption: logged("selectShippingOption", mockSelectShippingOption),
      selectShippingAddress: logged("selectShippingAddress", mockSelectShippingAddress),
      selectAuthenticityCheckOptIn: logged("selectAuthenticityCheckOptIn", mockSelectAuthenticityCheckOptIn),
      recordFulfillmentPreview: logged("recordFulfillmentPreview", mockRecordFulfillmentPreview),
      confirmCheckoutSession: logged("confirmCheckoutSession", mockConfirmCheckoutSession),
      createCheckoutSession: logged("createCheckoutSession", mockCreateCheckoutSession),
      getCheckoutEntryAttempt: logged("getCheckoutEntryAttempt", mockGetCheckoutEntryAttempt),
      mergeGuestCartToAccount: logged("mergeGuestCartToAccount", mockMergeGuestCartToAccount),
    };
  });
}

/** The calls the action made from its first command onward. */
function actionCallsFrom(command: string) {
  const posted = apiLog.filter((entry) => entry.startsWith("POST "));
  return posted.slice(posted.indexOf(`POST ${command}`));
}

async function settleRouter() {
  await waitFor(() => {
    expect(router?.state.initialized).toBe(true);
    expect(router?.state.navigation.state).toBe("idle");
    expect([...router!.state.fetchers.values()].every((fetcher) => fetcher.state === "idle")).toBe(true);
  });
}

function routeNativeSubmit(event: SubmitEvent) {
  if (event.defaultPrevented) return;
  event.preventDefault();
  const formData = new FormData(event.target as HTMLFormElement);
  const submitter = event.submitter as HTMLButtonElement | null;
  if (submitter?.name) formData.set(submitter.name, submitter.value);
  void router!.navigate(router!.state.location.pathname + router!.state.location.search, {
    formMethod: "post",
    formData,
  });
}

async function mount(initialEntry: string) {
  document.addEventListener("submit", routeNativeSubmit);
  router = createMemoryRouter(
    [
      {
        id: "checkout-start",
        path: "/checkout/buy/readiness",
        loader: startLoader,
        action: startAction,
        Component: CheckoutStartRoute,
        errorElement: <p>Route failed</p>,
      },
      {
        id: "checkout-session",
        path: "/checkout/buy/session/:sessionId",
        loader: sessionLoader,
        action: sessionAction,
        Component: CheckoutSessionRoute,
        errorElement: <p>Route failed</p>,
      },
    ],
    { initialEntries: [initialEntry] },
  );
  await settleRouter();
  const rendered = render(<RouterProvider router={router} />);
  unmount = rendered.unmount;
  await settleRouter();
}

/** A native or Base UI control refuses interaction by any of its disabled markers. */
function isDisabled(element: HTMLElement) {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled")
  );
}

function payButtons() {
  return screen.queryAllByRole("button", { name: /pay now/i });
}

function continueButtons() {
  return screen.queryAllByRole("button", { name: t("checkout.routes.checkoutStart.continue.to.checkout") });
}

function loaderEntryKey() {
  return (router!.state.loaderData["checkout-start"] as { entryAttemptKey: string }).entryAttemptKey;
}

function sentEntryKeys() {
  return mockCreateCheckoutSession.mock.calls.map(([body]) => (body as { entryAttemptKey?: string }).entryAttemptKey);
}

beforeEach(() => {
  apiLog = [];
  currentSession = checkoutSession();
  applyCheckoutRouteMockDefaults();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ available_balance_amount: "0.00", currency_code: "usd" })),
  );
  mockResolveActorFromAuthApi.mockResolvedValue(signedInActor);
  mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });
  mockCreateAuthRequestApiClient.mockReturnValue({});
  mockCreateIdentityRequestApiClient.mockReturnValue({});
  mockCreateMarketplaceRequestApiClient.mockReturnValue({});
  mockCreateOrderingRequestApiClient.mockReturnValue({});
  mockSelectShippingOption.mockResolvedValue(checkoutCommit("1", "evt_shipping"));
  mockSelectShippingAddress.mockResolvedValue(checkoutCommit("2", "evt_address"));
  mockSelectAuthenticityCheckOptIn.mockResolvedValue(checkoutCommit("3", "evt_authenticity"));
  mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("4", "evt_preview"));
  routeApi();
});

afterEach(() => {
  unmount?.();
  router?.dispose();
  router = undefined;
  unmount = undefined;
  document.removeEventListener("submit", routeNativeSubmit);
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("checkout start entry recovery through the data router", () => {
  it("holds a lost entry as ambiguous after one owner lookup of the sent attempt, and never resends it", async () => {
    mockCreateCheckoutSession.mockRejectedValue(new TypeError("fetch failed"));
    mockGetCheckoutEntryAttempt.mockResolvedValue({ ownerStatus: "not-observed" });
    await mount(startPath);
    const key = loaderEntryKey();

    await userEvent.click(continueButtons()[0]!);
    await settleRouter();

    const heading = await screen.findByRole("heading", {
      name: t("checkout.routes.checkoutStart.entry.ambiguous.title"),
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      screen.getByText(t("checkout.routes.checkoutStart.entry.ambiguous.description")).closest("[aria-live]"),
    ).not.toBeNull();
    expect(router!.state.actionData?.["checkout-start"]).toEqual({ entryState: "ambiguous" });
    expect(actionCallsFrom("createCheckoutSession")).toEqual([
      "POST createCheckoutSession",
      "POST getCheckoutEntryAttempt",
    ]);
    const [sent] = mockCreateCheckoutSession.mock.calls[0] as [Record<string, unknown>];
    expect(sent.entryAttemptKey).toBe(key);
    expect(mockGetCheckoutEntryAttempt).toHaveBeenCalledWith({
      attemptId: key,
      kind: "checkout-entry",
      target: "session",
      requestHash: await computeCheckoutEntryRequestHash(checkoutEntryPayload(sent, null)),
    });
    expect(continueButtons().every(isDisabled)).toBe(true);

    await userEvent.click(continueButtons()[0]!);
    await settleRouter();
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("opens the Session a lost entry's one lookup proves was committed", async () => {
    mockCreateCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(503, { error: { code: "upstream_unavailable" } }),
    );
    mockGetCheckoutEntryAttempt.mockResolvedValue({
      schemaVersion: 1,
      kind: "checkout-entry",
      fingerprint: "0".repeat(64),
      actorBinding: { kind: "account", digest: "0".repeat(64) },
      target: "session",
      requestHash: "0".repeat(64),
      ownerStatus: "committed",
      sessionId: "chk_recovery",
    });
    await mount(startPath);

    await userEvent.click(continueButtons()[0]!);
    await settleRouter();

    expect(router!.state.location.pathname).toBe(sessionPath);
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mockGetCheckoutEntryAttempt).toHaveBeenCalledTimes(1);
  });

  it("opens the Session a keyed entry's gateway timeout lookup proves was committed, without resending", async () => {
    mockCreateCheckoutSession.mockRejectedValue(new MockCheckoutApiError(504, { error: { code: "gateway_timeout" } }));
    mockGetCheckoutEntryAttempt.mockResolvedValue({
      schemaVersion: 1,
      kind: "checkout-entry",
      fingerprint: "0".repeat(64),
      actorBinding: { kind: "account", digest: "0".repeat(64) },
      target: "session",
      requestHash: "0".repeat(64),
      ownerStatus: "committed",
      sessionId: "chk_recovery",
    });
    await mount(startPath);
    const key = loaderEntryKey();

    await userEvent.click(continueButtons()[0]!);
    await settleRouter();

    expect(router!.state.location.pathname).toBe(sessionPath);
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    const [sent] = mockCreateCheckoutSession.mock.calls[0] as [Record<string, unknown>];
    expect(sent.entryAttemptKey).toBe(key);
    expect(mockGetCheckoutEntryAttempt).toHaveBeenCalledTimes(1);
    expect(mockGetCheckoutEntryAttempt).toHaveBeenCalledWith(expect.objectContaining({ attemptId: key }));
  });

  it("shows a start 409 as attempt-changed, and the refreshed page's new key opens one Session", async () => {
    mockCreateCheckoutSession
      .mockRejectedValueOnce(new MockCheckoutApiError(409, { error: { code: "checkout_attempt_conflict" } }))
      .mockResolvedValueOnce({ session_id: "chk_recovery", ...checkoutCommit("9", "evt_started") });
    await mount(startPath);
    const firstKey = loaderEntryKey();

    await userEvent.click(continueButtons()[0]!);
    await settleRouter();

    expect(await screen.findByText(t("checkout.routes.checkoutRecovery.checkout.attempt.changed"))).toBeTruthy();
    expect(router!.state.actionData?.["checkout-start"]).toMatchObject({
      recovery: { kind: "attempt-changed", status: 409, recoveryKind: "action-required" },
    });
    expect(mockGetCheckoutEntryAttempt).not.toHaveBeenCalled();

    await act(async () => {
      await router!.navigate(startPath);
    });
    await settleRouter();
    expect(loaderEntryKey()).not.toBe(firstKey);
    await userEvent.click(continueButtons()[0]!);
    await settleRouter();

    expect(router!.state.location.pathname).toBe(sessionPath);
    expect(sentEntryKeys()).toEqual([firstKey, expect.not.stringMatching(firstKey)]);
    expect(mockGetCheckoutEntryAttempt).not.toHaveBeenCalled();
  });

  it("refuses a keyless or malformed non-cart entry before sending any command", async () => {
    await mount(startPath);

    for (const entryAttemptKey of [null, "short"]) {
      const formData = new FormData();
      formData.set("source", "buy-now");
      if (entryAttemptKey) formData.set("entryAttemptKey", entryAttemptKey);
      await act(async () => {
        await router!.navigate(startPath, { formMethod: "post", formData });
      });
      await settleRouter();

      expect(router!.state.actionData?.["checkout-start"]).toMatchObject({ recovery: { kind: "attempt-changed" } });
    }
    expect(apiLog.filter((entry) => entry.startsWith("POST "))).toEqual([]);
  });
});

describe("checkout session confirm recovery through the data router", () => {
  it("holds a lost confirm as ambiguous after one Session read, never resends it, and keeps Pay now off", async () => {
    mockConfirmCheckoutSession.mockRejectedValue(new TypeError("fetch failed"));
    await mount(sessionPath);

    await userEvent.click(payButtons()[0]!);
    await settleRouter();

    const heading = await screen.findByRole("heading", {
      name: t("checkout.features.sessions.ui.checkoutPage.confirmation.ambiguous.title"),
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      screen
        .getByText(t("checkout.features.sessions.ui.checkoutPage.confirmation.ambiguous.description"))
        .closest("[aria-live]"),
    ).not.toBeNull();
    // The state comes from the action through the router, not from an injected prop.
    expect(router!.state.actionData?.["checkout-session"]).toEqual({ confirmationState: "ambiguous" });
    expect(actionCallsFrom("confirmCheckoutSession")).toEqual([
      "POST confirmCheckoutSession",
      "POST getCheckoutSession",
    ]);
    expect(payButtons().length).toBeGreaterThan(0);
    expect(payButtons().every(isDisabled)).toBe(true);

    await userEvent.click(payButtons()[0]!);
    await settleRouter();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("stays ambiguous when the one Session read shows orders but neither payment nor Offer", async () => {
    mockConfirmCheckoutSession.mockImplementation(async () => {
      currentSession = checkoutSession({ order_ids: ["ord_1"] });
      throw new MockCheckoutApiError(504, { error: { code: "gateway_timeout" } });
    });
    await mount(sessionPath);

    await userEvent.click(payButtons()[0]!);
    await settleRouter();

    expect(router!.state.actionData?.["checkout-session"]).toEqual({ confirmationState: "ambiguous" });
    expect(actionCallsFrom("confirmCheckoutSession")).toEqual([
      "POST confirmCheckoutSession",
      "POST getCheckoutSession",
    ]);
    expect(payButtons().every(isDisabled)).toBe(true);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("returns the first result when the one Session read shows the started payment", async () => {
    mockConfirmCheckoutSession.mockImplementation(async () => {
      currentSession = checkoutSession({ order_ids: ["ord_1"], payment_id: "pay_1" });
      throw new MockCheckoutApiError(503, { error: { code: "upstream_unavailable" } });
    });
    await mount(sessionPath);

    await userEvent.click(payButtons()[0]!);
    await settleRouter();

    expect(router!.state.location.pathname).toBe(sessionPath);
    expect(router!.state.actionData).toBeNull();
    expect(actionCallsFrom("confirmCheckoutSession")).toEqual([
      "POST confirmCheckoutSession",
      "POST getCheckoutSession",
    ]);
    expect(
      screen.queryByRole("heading", {
        name: t("checkout.features.sessions.ui.checkoutPage.confirmation.ambiguous.title"),
      }),
    ).toBeNull();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("shows a bound-hash 409 as changed without any further owner call", async () => {
    mockConfirmCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(409, { error: { code: "checkout_confirmation_changed" }, session: currentSession }),
    );
    await mount(sessionPath);

    await userEvent.click(payButtons()[0]!);
    await settleRouter();

    expect(await screen.findByText(t("checkout.routes.checkoutSession.confirmation.changed"))).toBeTruthy();
    expect(router!.state.actionData?.["checkout-session"]).toMatchObject({ confirmationState: "changed" });
    expect(actionCallsFrom("confirmCheckoutSession")).toEqual(["POST confirmCheckoutSession"]);
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("never shows the ambiguous result from navigation alone", async () => {
    await mount(`${sessionPath}?confirmationState=ambiguous`);

    expect(router!.state.actionData).toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: t("checkout.features.sessions.ui.checkoutPage.confirmation.ambiguous.title"),
      }),
    ).toBeNull();
    expect(payButtons().some((button) => !isDisabled(button))).toBe(true);
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });
});
