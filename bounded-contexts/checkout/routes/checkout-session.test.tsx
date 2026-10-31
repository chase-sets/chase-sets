// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Hono } from "hono";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type GlobalPosition } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { CheckoutApiEnv } from "../api";
import {
  MockCheckoutApiError,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockResolveActorFromAuthApi,
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
import { createAccountCheckoutSessionRoutes } from "../features/sessions/api/route";
import { createCheckoutSessionRuntime } from "../features/sessions/api/runtime";

const sessionId = "chk_held_page";
const sessionPath = `/checkout/buy/session/${sessionId}`;
const buyer = {
  sessionId: "ses_buyer",
  tenantId: "tnt_identity",
  userId: "usr_buyer",
  accountId: "acc_buyer",
  membershipId: "mbr_buyer",
  roleKey: "owner",
  permissions: ["orders.view"],
};
const shippingAddress = {
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
const heldReservations = [
  {
    holdId: "hld_page_a",
    lineKey: "line_1",
    sellerAccountId: "seller_1",
    inventoryItemId: "inventory_1",
    quantity: 2,
    expiresAt: "2099-01-01T00:15:00.000Z",
    extensionCount: 0,
    status: "active",
  },
] as const;

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();
  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

/**
 * The Checkout session API mounted for real (route, runtime, in-memory event
 * store and the deterministic Inventory release helper); only Inventory's HTTP
 * endpoint is a double, measuring available quantity on hand less active holds.
 */
async function checkoutBackend() {
  const { eventStore, readAllEvents } = createInMemoryEventStore();
  const context = {
    tenantId: buyer.tenantId as never,
    audit: { performedByUserId: buyer.userId as never, forAccountId: buyer.accountId as never },
  };
  await eventStore.appendToStream({
    streamId: `checkout.session-${sessionId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "checkout.session.started",
        payload: {
          sessionId,
          buyerAccountId: buyer.accountId,
          sourceType: "buy-now",
          optimizationGoal: "lowest-total",
          fulfillmentPreviewRevision: null,
          fulfillmentPreviewSnapshot: null,
          cartReadinessSnapshot: null,
          presentedAnonymousCartId: null,
          splitGroupHandoff: null,
          shippingOption: "standard",
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
              quantity: 2,
              fulfillmentMode: "locked-listing",
              lockedListingId: "listing_1",
              sellerPreferenceId: null,
              availabilityState: "available",
            },
          ],
          handoffExpiresAt: null,
          createdAt: "2099-01-01T00:00:00.000Z",
        } as never,
      },
      // Confirm sets the delivery address before it reserves, so a held session has one.
      {
        eventType: "checkout.session.shipping-address-set",
        payload: { sessionId, shippingAddress, selectedAt: "2099-01-01T00:00:00.000Z" } as never,
      },
      {
        eventType: "checkout.session.reservations-recorded",
        payload: { sessionId, reservations: heldReservations, recordedAt: "2099-01-01T00:00:00.000Z" } as never,
      },
    ],
  });
  const services = createCheckoutSessionRuntime({
    eventStore,
    checkpointStore: createCheckpointStore(),
    db: { query: vi.fn(async () => ({ rows: [] })) },
    cart: {} as never,
  });
  const app = new Hono<CheckoutApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", buyer as never);
    c.set("context", context as never);
    await next();
  });
  app.route("/account", createAccountCheckoutSessionRoutes(services));

  const onHand = 3;
  const holds = new Map<string, { holdId: string; quantity: number; status: string }>(
    heldReservations.map((reservation) => [reservation.holdId, { ...reservation }]),
  );
  const releaseCalls: string[] = [];
  const available = () =>
    onHand -
    [...holds.values()].filter((hold) => hold.status === "active").reduce((sum, hold) => sum + hold.quantity, 0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const holdId = /checkout-reservations\/([^/]+)\/release/.exec(String(input))?.[1];
      const hold = holdId ? holds.get(holdId) : undefined;
      if (!hold) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      releaseCalls.push(hold.holdId);
      hold.status = "released";
      return Response.json(hold);
    }),
  );

  const callApi = async (path: string, init?: RequestInit) => {
    const response = await app.fetch(new Request(`http://checkout.test/account${path}`, init));
    const body = await response.json();
    if (!response.ok) throw new MockCheckoutApiError(response.status, body);
    return body;
  };
  const cancelResults: unknown[] = [];
  mockCreateCheckoutRequestApiClient.mockImplementation(() => ({
    getCheckoutSession: (id: string) => callApi(`/checkout-sessions/${id}`),
    cancelCheckoutSession: async (id: string) => {
      const result = await callApi(`/checkout-sessions/${id}/cancel`, { method: "POST" });
      cancelResults.push(result);
      return result;
    },
    listCheckoutSavedPaymentInstruments: vi.fn(async () => ({ items: [] })),
    listSellListShipFromAddresses: vi.fn(async () => ({ items: [] })),
  }));

  return {
    available,
    releaseCalls,
    cancelResults,
    cancelledEvents: () => readAllEvents().filter((event) => event.eventType === "checkout.session.cancelled"),
  };
}

let router: ReturnType<typeof createMemoryRouter> | undefined;
let unmount: (() => void) | undefined;
// The router navigation a native submit started; it settles after the action,
// its redirect and the reloaded loaders, so tests await it instead of polling.
let pendingSubmission: Promise<void> | undefined;

async function settleRouter() {
  await waitFor(() => {
    expect(router?.state.initialized).toBe(true);
    expect(router?.state.navigation.state).toBe("idle");
  });
}

function routeNativeSubmit(event: SubmitEvent) {
  if (event.defaultPrevented) return;
  event.preventDefault();
  const formData = new FormData(event.target as HTMLFormElement);
  const submitter = event.submitter as HTMLButtonElement | null;
  if (submitter?.name) formData.set(submitter.name, submitter.value);
  pendingSubmission = router!.navigate(router!.state.location.pathname + router!.state.location.search, {
    formMethod: "post",
    formData,
  });
}

async function mount() {
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
    { initialEntries: [sessionPath] },
  );
  await settleRouter();
  unmount = render(<RouterProvider router={router} />).unmount;
  await settleRouter();
}

describe("cancel checkout through the checkout session data router", () => {
  beforeEach(() => {
    mockResolveActorFromAuthApi.mockResolvedValue(buyer);
    mockCreateAuthRequestApiClient.mockReturnValue({});
    mockCreateIdentityRequestApiClient.mockReturnValue({ listShippingAddresses: vi.fn(async () => ({ items: [] })) });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateOrderingRequestApiClient.mockReturnValue({});
  });

  afterEach(() => {
    unmount?.();
    router?.dispose();
    router = undefined;
    unmount = undefined;
    pendingSubmission = undefined;
    document.removeEventListener("submit", routeNativeSubmit);
    cleanup();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("releases the held items once from the page and answers a repeated cancel as already cancelled", async () => {
    const backend = await checkoutBackend();
    await mount();

    expect(backend.available()).toBe(1);
    const cancelButton = screen.getByRole("button", {
      name: t("checkout.features.sessions.ui.checkoutPage.cancel.checkout"),
    });

    await userEvent.click(cancelButton);
    await act(async () => {
      await pendingSubmission;
    });
    await settleRouter();

    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.checkout.cancelled"))).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: t("checkout.features.sessions.ui.checkoutPage.cancel.checkout") }),
    ).toBeNull();
    expect(backend.available()).toBe(3);
    expect(backend.releaseCalls).toEqual(["hld_page_a"]);
    expect(backend.cancelledEvents()).toHaveLength(1);
    expect(backend.cancelResults).toEqual([expect.objectContaining({ status: "cancelled" })]);

    // A stale second tab submits the same intent after the session is cancelled.
    const repeat = new FormData();
    repeat.set("intent", "cancel-checkout");
    await act(async () => {
      await router!.navigate(sessionPath, { formMethod: "post", formData: repeat });
    });
    await waitFor(() => expect(backend.cancelResults).toHaveLength(2));
    await settleRouter();

    expect(backend.cancelResults).toEqual([
      expect.objectContaining({ status: "cancelled" }),
      expect.objectContaining({ status: "already-cancelled", released_reservation_ids: [] }),
    ]);
    expect(backend.releaseCalls).toEqual(["hld_page_a"]);
    expect(backend.available()).toBe(3);
    expect(backend.cancelledEvents()).toHaveLength(1);
    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.checkout.cancelled"))).toBeTruthy();
  });
});
