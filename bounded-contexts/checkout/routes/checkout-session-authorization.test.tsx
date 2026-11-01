// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../support/request-support/api-client";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockConfirmCheckoutSession,
  mockGetCheckoutSession,
  mockListSellListShipFromAddresses,
  mockRecordFulfillmentPreview,
  mockResolveActorFromAuthApi,
  mockSelectAuthenticityCheckOptIn,
  mockSelectShippingAddress,
  mockSelectShippingOption,
} from "../tests/support/checkout-route-test-harness";

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

import CheckoutSessionRoute, { action, loader } from "./checkout-session";

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

function checkoutSession(sourceType: "cart" | "buy-now" = "buy-now"): CheckoutSessionRow {
  return {
    session_id: "chk_route_matrix",
    buyer_account_id: "acc_buyer",
    source_type: sourceType,
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
        cartLineId: sourceType === "cart" ? "line_1" : null,
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
  };
}

const signedInActor = { accountId: "acc_buyer", roleKey: "owner", permissions: ["orders.view", "payouts.view"] };
const savedInstrument = {
  instrument_id: "sci_card_1",
  payment_method_category: "card",
  display_label: "Visa ending in 4242",
  confirmation_experience: "trusted-payment-step",
  is_default: true,
  readiness: "ready",
  removed_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

let router: ReturnType<typeof createMemoryRouter> | undefined;
let unmount: (() => void) | undefined;
let requestSubmitSpy: ReturnType<typeof vi.spyOn> | undefined;

function routeApi(session = checkoutSession(), withSavedInstrument = false) {
  mockGetCheckoutSession.mockResolvedValue(session);
  mockCreateCheckoutRequestApiClient.mockReturnValue({
    getCheckoutSession: mockGetCheckoutSession,
    listSellListShipFromAddresses: mockListSellListShipFromAddresses,
    listCheckoutSavedPaymentInstruments: vi.fn(async () => ({ items: withSavedInstrument ? [savedInstrument] : [] })),
    selectShippingOption: mockSelectShippingOption,
    selectShippingAddress: mockSelectShippingAddress,
    selectAuthenticityCheckOptIn: mockSelectAuthenticityCheckOptIn,
    recordFulfillmentPreview: mockRecordFulfillmentPreview,
    confirmCheckoutSession: mockConfirmCheckoutSession,
  });
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
        id: "checkout-session",
        path: "/checkout/buy/session/:sessionId",
        loader,
        action,
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

async function settlePhase() {
  await settleRouter();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expectNoCheckoutWrites();
}

function expectNoCheckoutWrites() {
  expect(requestSubmitSpy).not.toHaveBeenCalled();
  expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  expect(mockSelectShippingOption).not.toHaveBeenCalled();
  expect(mockSelectShippingAddress).not.toHaveBeenCalled();
  expect(mockSelectAuthenticityCheckOptIn).not.toHaveBeenCalled();
  expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
}

describe("checkout session authorization through the data router", () => {
  beforeEach(() => {
    requestSubmitSpy = vi.spyOn(HTMLFormElement.prototype, "requestSubmit");
    applyCheckoutRouteMockDefaults();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ available_balance_amount: "0.00", currency_code: "usd" })),
    );
    mockListSellListShipFromAddresses.mockResolvedValue({ items: [] });
    mockCreateAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext: vi.fn(async () => ({
        contactEmail: "guest@example.com",
        contactName: "Guest Buyer",
      })),
    });
    mockCreateIdentityRequestApiClient.mockReturnValue({});
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateOrderingRequestApiClient.mockReturnValue({});
    mockSelectShippingOption.mockResolvedValue(checkoutCommit("1", "evt_shipping"));
    mockSelectShippingAddress.mockResolvedValue(checkoutCommit("2", "evt_address"));
    mockSelectAuthenticityCheckOptIn.mockResolvedValue(checkoutCommit("3", "evt_authenticity"));
    mockRecordFulfillmentPreview.mockResolvedValue(checkoutCommit("4", "evt_preview"));
    mockConfirmCheckoutSession.mockResolvedValue({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
      status: "confirmed",
      ...checkoutCommit("5", "evt_confirm"),
    });
  });

  afterEach(() => {
    unmount?.();
    router?.dispose();
    router = undefined;
    unmount = undefined;
    document.removeEventListener("submit", routeNativeSubmit);
    cleanup();
    requestSubmitSpy?.mockRestore();
    requestSubmitSpy = undefined;
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["cart", "guest", guestCheckoutActor(), false],
    ["cart", "signed-in", signedInActor, false],
    ["cart", "saved-method", signedInActor, true],
    ["buy-now", "guest", guestCheckoutActor(), false],
    ["buy-now", "signed-in", signedInActor, false],
    ["buy-now", "saved-method", signedInActor, true],
  ] as const)(
    "navigation does not authorize checkout for %s %s",
    async (sourceType, _kind, actor, withSavedInstrument) => {
      mockResolveActorFromAuthApi.mockResolvedValue(actor);
      routeApi(checkoutSession(sourceType), withSavedInstrument);

      const sessionPath = "/checkout/buy/session/chk_route_matrix";
      await mount(sessionPath);
      expect(screen.getAllByRole("heading", { name: /checkout/i }).length).toBeGreaterThan(0);
      await settlePhase();

      await act(async () => {
        await router!.revalidate();
      });
      await settlePhase();

      unmount?.();
      const remounted = render(<RouterProvider router={router!} />);
      unmount = remounted.unmount;
      await settlePhase();

      await act(async () => {
        await router!.navigate(sessionPath);
      });
      await settlePhase();

      await act(async () => {
        await router!.navigate(`${sessionPath}?measurement=1`);
      });
      await settlePhase();

      await act(async () => {
        await router!.navigate(-1);
      });
      await settlePhase();

      await act(async () => {
        await router!.navigate(`${sessionPath}?resumePaymentStart=1`);
      });
      await settlePhase();

      await act(async () => {
        await router!.navigate(`${sessionPath}?edit=delivery`);
      });
      await settlePhase();
    },
  );

  it("only Pay commits a fresh checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(signedInActor);
    routeApi();

    await mount("/checkout/buy/session/chk_route_matrix");
    const payButtons = screen.getAllByRole("button", { name: /pay now/i });
    expect(payButtons.length).toBeGreaterThan(0);
    expect((payButtons[0] as HTMLButtonElement).disabled).toBe(false);

    expectNoCheckoutWrites();
    await userEvent.click(payButtons[0]);
    await settleRouter();

    expect(mockSelectShippingOption).toHaveBeenCalledTimes(1);
    expect(mockSelectAuthenticityCheckOptIn).toHaveBeenCalledTimes(1);
    expect(mockRecordFulfillmentPreview).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).toHaveBeenCalledTimes(1);
  });
});
