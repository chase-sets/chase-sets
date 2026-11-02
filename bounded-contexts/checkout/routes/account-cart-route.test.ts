import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  appendPostWriteHandoff,
  encodePostWriteHandoff,
  readCompactPostWriteToken,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { registerPostWriteConsistencyRecorder } from "@chase-sets/platform-runtime/post-write-consistency";
import { ACCOUNT_CART_ADD_LINE_HANDOFF } from "../support/request-support/account-cart-handoffs";
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
  mockCreatePaymentsRequestApiClient,
  mockGetCart,
  mockGetGuestCart,
  MockMarketplaceApiError,
  mockGetCartCommandAttempt,
  mockGetGuestCartCommandAttempt,
  mockRemoveCartLine,
  mockRemoveGuestCartLine,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockSubmitCartCommands,
  mockSubmitGuestCartCommands,
  mockUpdateCartLineFulfillment,
  mockUpdateCartLineQuantity,
  mockUpdateGuestCartLineFulfillment,
  mockUpdateGuestCartLineQuantity,
} from "../tests/support/checkout-route-test-harness";
import { cartAttemptResult, committedCartAttempt } from "../tests/support/cart-attempt-results";

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

async function readResolvedFreshWriteToken(location: string | null) {
  const request = new Request(new URL(location ?? "", "http://localhost"));
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  return readFreshWriteToken(resolvedRequest);
}

function expectCompactPostWriteLocation(location: string | null, expectedPrefix: string) {
  expect(location).toContain(expectedPrefix);
  expect(readCompactPostWriteToken(location ?? "")).toMatch(/^pwt_/);
  expect(location).not.toContain("afterWrite=");
  expect(location).not.toContain("postWriteHandoff=");
}

import { action as accountCartAction, loader as accountCartLoader } from "./account-cart";

const mockPostWriteConsistencyRecorder = vi.fn();
let unregisterPostWriteConsistencyRecorder: (() => void) | null = null;

describe("checkout web routes: account cart", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
    unregisterPostWriteConsistencyRecorder = registerPostWriteConsistencyRecorder(mockPostWriteConsistencyRecorder);
  });

  afterEach(() => {
    unregisterPostWriteConsistencyRecorder?.();
    unregisterPostWriteConsistencyRecorder = null;
    vi.resetAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("falls back to the anonymous cart when guest checkout returns to cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetGuestCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
      getGuestCart: mockGetGuestCart,
    });

    const result = await accountCartLoader({
      request: new Request("http://localhost/account/cart", {
        headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [], count: 0 },
      cartRecovery: null,
    });
    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
  });

  it("passes the API readiness projection through for both account and guest loader branches", async () => {
    const readiness = {
      loaded: { snapshotId: "loaded_api_value" },
      declined: { snapshotId: "declined_api_value" },
      accepted: null,
      lineListingIds: { cli_api: "lst_api" },
      estimatedSubtotal: { amount: "17.23", currency: "USD" },
      blockedLineCount: 3,
      savings: { amount: "4.56", currency: "USD" },
    };

    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [{ line_id: "cli_api" }], count: 1, readiness });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });
    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart"),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toEqual({ cart: { items: [{ line_id: "cli_api" }], count: 1, readiness }, cartRecovery: null });

    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetGuestCart.mockResolvedValue({ items: [{ line_id: "cli_api" }], count: 1, readiness });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getGuestCart: mockGetGuestCart });
    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart", {
          headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
        }),
        params: {},
        context: undefined,
      } as never),
    ).resolves.toEqual({ cart: { items: [{ line_id: "cli_api" }], count: 1, readiness }, cartRecovery: null });
  });

  it("recovers signed-in account cart self-refresh when a fresh receipt times out waiting for projection freshness", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
    );

    const result = await accountCartLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    expect(mockCreateCheckoutRequestApiClient).toHaveBeenCalledWith(request);
    expect(result).toEqual({
      cart: null,
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "refreshable-catching-up",
        message: expect.any(String),
      },
    });
  });

  it("engages the account cart projection wait when discovery's View cart link carries an add-to-cart receipt, but reads empty without one", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });

    // Freshness still matters for projection timeouts; the semantic add-line
    // handoff below covers successful reads that are still stale-empty.
    const viewCartHref = appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_cart_line"));
    expect(readFreshWriteToken(new URL(viewCartHref, "http://localhost"))).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cart_line"] }],
    });

    // With the token, a still-lagging cart projection is a transient freshness timeout the
    // loader recovers from after engaging the projection wait, rather than surfacing as a hard failure.
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const withToken = await accountCartLoader({
      request: new Request(`http://localhost${viewCartHref}`),
      params: {},
      context: undefined,
    } as never);

    expect(withToken).toEqual({
      cart: null,
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "refreshable-catching-up",
        message: expect.any(String),
      },
    });

    // Without the token (the pre-fix static href="/account/cart"), the same lagging projection
    // is treated as a permanent failure: the loader never waits and the cart cannot self-heal.
    vi.clearAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("shows temporary cart recovery when a valid add-line handoff still reads an empty projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [], count: 0 },
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "pending-projection",
        message: expect.any(String),
      },
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith({
      boundedContextName: "checkout",
      surface: "account-cart",
      strategy: "fresh-read",
      outcome: "handoff_pending",
      routeId: "account-cart",
      routeTemplate: "/account/cart",
      correctionSource: "semantic-handoff:checkout.cart.add-line",
      actorMode: "account",
      recoveryAction: "pending_empty_state",
      freshnessOutcome: "valid-after-write",
    });
  });

  it("keeps a selected listing add-line handoff pending until checkout seller options include the locked listing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({
      items: [
        {
          line_id: "cli_selected",
          fulfillment_mode: "locked-listing",
          locked_listing_id: "lst_new",
          selected_listing_id: "lst_new",
          availability_state: "available",
          seller_options: [],
        },
      ],
      count: 1,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: {
        items: [
          expect.objectContaining({
            line_id: "cli_selected",
            locked_listing_id: "lst_new",
            seller_options: [],
          }),
        ],
        count: 1,
      },
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "pending-projection",
        message: expect.any(String),
      },
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_pending",
        actorMode: "account",
        recoveryAction: "pending_empty_state",
      }),
    );
  });

  it("satisfies a selected listing add-line handoff after checkout seller options include the locked listing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({
      items: [
        {
          line_id: "cli_selected",
          fulfillment_mode: "locked-listing",
          locked_listing_id: "lst_new",
          selected_listing_id: "lst_new",
          availability_state: "available",
          seller_options: [
            {
              listing_id: "lst_new",
              available_quantity: 1,
              price_amount: "4.77",
              product_measure_snapshot: {
                catalogItemId: "cat_1",
                productId: "prd_1",
                measureVersion: "pm_test_raw_v1",
              },
            },
          ],
        },
      ],
      count: 1,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: {
        items: [
          expect.objectContaining({
            line_id: "cli_selected",
            locked_listing_id: "lst_new",
          }),
        ],
        count: 1,
      },
      cartRecovery: null,
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_satisfied",
        actorMode: "account",
        recoveryAction: "none",
      }),
    );
  });

  it("renders normal cart readiness when selected listing seller-options catch-up outlives the handoff", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({
      items: [
        {
          line_id: "cli_selected",
          fulfillment_mode: "locked-listing",
          locked_listing_id: "lst_new",
          selected_listing_id: "lst_new",
          availability_state: "available",
          seller_options: [],
        },
      ],
      count: 1,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const cart = { items: [expect.objectContaining({ line_id: "cli_selected" })], count: 1 };
    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
          Date.now() - 40_000,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ cart, cartRecovery: null });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_expired",
        recoveryAction: "none",
      }),
    );
  });

  it("shows temporary guest cart recovery when a valid add-line handoff still reads an empty projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockGetGuestCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getGuestCart: mockGetGuestCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_guest_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
        )}`,
        {
          headers: { cookie: "chase_sets_anonymous_cart=anon_cart_1" },
        },
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [], count: 0 },
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "pending-projection",
        message: expect.any(String),
      },
    });
    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_pending",
        actorMode: "guest",
        recoveryAction: "pending_empty_state",
      }),
    );
  });

  it("keeps the normal empty-cart state when an empty projection is not tied to an add-line handoff", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_remove_line"))}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [], count: 0 },
      cartRecovery: null,
    });
    expect(mockPostWriteConsistencyRecorder).not.toHaveBeenCalled();
  });

  it("records satisfied account cart add-line handoffs when the cart projection contains lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [{ line_id: "cli_1" }], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [{ line_id: "cli_1" }], count: 1 },
      cartRecovery: null,
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_satisfied",
        actorMode: "account",
        recoveryAction: "none",
        freshnessOutcome: "valid-after-write",
      }),
    );
  });

  it.each([
    {
      name: "unpaired",
      href: `/account/cart?postWriteHandoff=${encodePostWriteHandoff(ACCOUNT_CART_ADD_LINE_HANDOFF)}`,
      outcome: "handoff_invalid",
      freshnessOutcome: "missing-after-write",
    },
    {
      name: "malformed",
      href: `${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_cart_line"))}&postWriteHandoff=%7Bnot-json`,
      outcome: "handoff_malformed",
      freshnessOutcome: "malformed-handoff",
    },
    {
      name: "far-future",
      href: appendPostWriteHandoff(
        "/account/cart",
        checkoutCommit("42", "evt_cart_line"),
        ACCOUNT_CART_ADD_LINE_HANDOFF,
        Date.now() + 60_000,
      ),
      outcome: "handoff_invalid",
      freshnessOutcome: "future-after-write",
    },
    {
      name: "wrong-kind",
      href: appendPostWriteHandoff("/account/cart", checkoutCommit("42", "evt_cart_line"), {
        kind: "marketplace.listing.publish",
        expectation: "collection-non-empty",
        surface: "account-cart",
      }),
      outcome: "handoff_invalid",
      freshnessOutcome: "valid-after-write",
    },
  ])(
    "keeps normal empty-cart state for $name semantic handoff metadata",
    async ({ href, outcome, freshnessOutcome }) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockResolvedValue({ items: [], count: 0 });
      mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

      const result = await accountCartLoader({
        request: new Request(`http://localhost${href}`),
        params: {},
        context: undefined,
      } as never);

      expect(result).toEqual({
        cart: { items: [], count: 0 },
        cartRecovery: null,
      });
      expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome,
          freshnessOutcome,
          recoveryAction: "none",
        }),
      );
    },
  );

  it("shows actionable cart recovery when an expired add-line handoff still reads an empty projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
          Date.now() - 40_000,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: { items: [], count: 0 },
      cartRecovery: {
        kind: "missing-after-fresh-write",
        recoveryKind: "expired-handoff",
        message: expect.any(String),
      },
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_expired",
        freshnessOutcome: "expired-after-write",
        recoveryAction: "action_required",
      }),
    );
  });

  it("shows actionable cart recovery for expired add-line handoffs when the cart read still times out", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart: mockGetCart });

    const result = await accountCartLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/cart",
          checkoutCommit("42", "evt_cart_line"),
          ACCOUNT_CART_ADD_LINE_HANDOFF,
          Date.now() - 40_000,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      cart: null,
      cartRecovery: {
        kind: "missing-after-fresh-write",
        recoveryKind: "expired-handoff",
        message: expect.any(String),
      },
    });
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_expired",
        freshnessOutcome: "expired-after-write",
        recoveryAction: "action_required",
      }),
    );
  });

  it("recovers signed-in account cart self-refresh when a fresh receipt reads a transient not-found cart", async () => {
    vi.useFakeTimers();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(404, {
        error: {
          code: "not_found",
          message: "Cart projection has not caught up yet.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
    );

    const resultPromise = accountCartLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      cart: null,
      cartRecovery: {
        kind: "pending-fresh-write",
        recoveryKind: "refreshable-catching-up",
        message: expect.any(String),
      },
    });
    expect(mockGetCart).toHaveBeenCalledTimes(6);
  });

  it.each([502, 503, 504])(
    "recovers signed-in account cart self-refresh when a fresh receipt reads an opaque %i gateway error",
    async (status) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(new MockCheckoutApiError(status, null));
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });
      const request = new Request(
        `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
      );

      const result = await accountCartLoader({
        request,
        params: {},
        context: undefined,
      } as never);

      expect(result).toEqual({
        cart: null,
        cartRecovery: {
          kind: "pending-fresh-write",
          recoveryKind: "refreshable-catching-up",
          message: expect.any(String),
        },
      });
    },
  );

  it("treats account cart projection timeouts without a fresh receipt as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });

    await expect(
      accountCartLoader({
        request: new Request("http://localhost/account/cart"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    {
      name: "malformed",
      href: "/account/cart?afterWrite=%7Bnot-json",
    },
    {
      name: "far-future",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() + 60_000),
    },
  ])(
    "treats account cart projection timeouts with $name fresh receipts as permanent loader failures",
    async ({ href }) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(
        new MockCheckoutApiError(503, {
          error: {
            code: "projection_freshness_timeout",
            message: "Projection read model did not catch up before the freshness timeout.",
          },
        }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });

      await expect(
        accountCartLoader({
          request: new Request(`http://localhost${href}`),
          params: {},
          context: undefined,
        } as never),
      ).rejects.toMatchObject({ status: 503 });
    },
  );

  it("treats account cart projection timeouts with expired fresh receipts as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/cart",
        checkoutCommit("42", "evt_checkout"),
        Date.now() - 40_000,
      )}`,
    );

    await expect(
      accountCartLoader({
        request,
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([401, 403])(
    "treats account cart authorization status %i with fresh receipts as permanent loader failures",
    async (status) => {
      mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
      mockGetCart.mockRejectedValue(
        new MockCheckoutApiError(status, {
          error: {
            code: status === 401 ? "authentication_required" : "authorization_forbidden",
            message: "Authentication required.",
          },
        }),
      );
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getCart: mockGetCart,
      });
      const request = new Request(
        `http://localhost${appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"))}`,
      );

      await expect(
        accountCartLoader({
          request,
          params: {},
          context: undefined,
        } as never),
      ).rejects.toMatchObject({ status });
    },
  );

  it.each([
    {
      name: "missing",
      href: "/account/cart",
    },
    {
      name: "malformed",
      href: "/account/cart?afterWrite=%7Bnot-json",
    },
    {
      name: "expired",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() - 40_000),
    },
    {
      name: "far-future",
      href: appendFreshWriteToken("/account/cart", checkoutCommit("42", "evt_checkout"), Date.now() + 60_000),
    },
  ])("treats account cart not-found reads with $name receipts as permanent loader failures", async ({ href }) => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockRejectedValue(
      new MockCheckoutApiError(404, {
        error: {
          code: "not_found",
          message: "Cart not found.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
    });

    await expect(
      accountCartLoader({
        request: new Request(`http://localhost${href}`),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  const PRESENTED_ATTEMPT_ID = "attempt_account_cart_action_0001";

  function cartActionRequest(form: URLSearchParams, guest = false) {
    return accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(guest ? { cookie: "chase_sets_anonymous_cart=anon_cart_1" } : {}),
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);
  }

  function cartAttemptClient() {
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      submitCartCommands: mockSubmitCartCommands,
      submitGuestCartCommands: mockSubmitGuestCartCommands,
      getCartCommandAttempt: mockGetCartCommandAttempt,
      getGuestCartCommandAttempt: mockGetGuestCartCommandAttempt,
    });
  }

  function expectNoPerLineCartWrites() {
    for (const perLineWrite of [
      mockUpdateCartLineQuantity,
      mockUpdateGuestCartLineQuantity,
      mockUpdateCartLineFulfillment,
      mockUpdateGuestCartLineFulfillment,
      mockRemoveCartLine,
      mockRemoveGuestCartLine,
    ]) {
      expect(perLineWrite).not.toHaveBeenCalled();
    }
  }

  it("submits a grouped quantity update as one attempt: the primary quantity and every duplicate removal together", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "quantity", lineId: "cli_primary" },
        { command: "remove", lineId: "cli_duplicate" },
      ]),
      ...checkoutCommit("44", "evt_quantity_and_duplicate_removed"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "2");
    form.set("quantityDelta", "1");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "update-cart-line");

    const response = (await cartActionRequest(form)) as Response;

    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockSubmitCartCommands).toHaveBeenCalledWith({
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [
        { type: "quantity", lineId: "cli_primary", quantity: 3 },
        { type: "remove", lineId: "cli_duplicate" },
      ],
    });
    expectNoPerLineCartWrites();
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "44",
      sources: [
        { sourceContextName: "checkout", maxGlobalPosition: "44", eventIds: ["evt_quantity_and_duplicate_removed"] },
      ],
    });
  });

  it("uses absolute optimistic quantity for signed-in grouped cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "quantity", lineId: "cli_primary" },
        { command: "remove", lineId: "cli_duplicate" },
      ]),
      ...checkoutCommit("48", "evt_quantity"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "5");
    form.set("quantityDelta", "1");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "update-cart-line");

    const response = (await cartActionRequest(form)) as Response;

    expect(mockSubmitCartCommands).toHaveBeenCalledWith({
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [
        { type: "quantity", lineId: "cli_primary", quantity: 5 },
        { type: "remove", lineId: "cli_duplicate" },
      ],
    });
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
  });

  it("uses absolute optimistic quantity for guest cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSubmitGuestCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([{ command: "quantity", lineId: "cli_guest" }]),
      ...checkoutCommit("50", "evt_guest_quantity"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("quantity", "4");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("optimisticSequence", "2");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "update-cart-line");

    const response = (await cartActionRequest(form, true)) as Response;

    expect(mockSubmitGuestCartCommands).toHaveBeenCalledWith("anon_cart_1", {
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [{ type: "quantity", lineId: "cli_guest", quantity: 4 }],
    });
    expect(mockSubmitCartCommands).not.toHaveBeenCalled();
    expectNoPerLineCartWrites();
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
  });

  it("locks preferred listing fulfillment for every signed-in grouped cart line in one attempt", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "fulfillment", lineId: "cli_primary" },
        { command: "fulfillment", lineId: "cli_duplicate" },
      ]),
      ...checkoutCommit("46", "evt_grouped_locked"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "lock-preferred-listing");

    const response = (await cartActionRequest(form)) as Response;

    const locked = {
      type: "fulfillment",
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    };
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockSubmitCartCommands).toHaveBeenCalledWith({
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [
        { ...locked, lineId: "cli_primary" },
        { ...locked, lineId: "cli_duplicate" },
      ],
    });
    expectNoPerLineCartWrites();
    expect(response.status).toBe(302);
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "46",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "46", eventIds: ["evt_grouped_locked"] }],
    });
  });

  it("locks preferred listing fulfillment for guest cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSubmitGuestCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([{ command: "fulfillment", lineId: "cli_guest" }]),
      ...checkoutCommit("47", "evt_guest_locked"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "lock-preferred-listing");

    const response = (await cartActionRequest(form, true)) as Response;

    expect(mockSubmitGuestCartCommands).toHaveBeenCalledWith("anon_cart_1", {
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [
        {
          type: "fulfillment",
          lineId: "cli_guest",
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_card_vault",
          sellerPreferenceId: "lst_card_vault",
          availabilityState: "available",
        },
      ],
    });
    expect(response.status).toBe(302);
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "47",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "47", eventIds: ["evt_guest_locked"] }],
    });
  });

  it("removes every grouped cart line id in one attempt from the simplified cart page", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "remove", lineId: "cli_primary" },
        { command: "remove", lineId: "cli_duplicate" },
      ]),
      ...checkoutCommit("46", "evt_grouped_removed"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "remove-cart-line");

    const response = (await cartActionRequest(form)) as Response;

    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockSubmitCartCommands).toHaveBeenCalledWith({
      attemptId: PRESENTED_ATTEMPT_ID,
      commands: [
        { type: "remove", lineId: "cli_primary" },
        { type: "remove", lineId: "cli_duplicate" },
      ],
    });
    expectNoPerLineCartWrites();
    expect(response.status).toBe(302);
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "46",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "46", eventIds: ["evt_grouped_removed"] }],
    });
  });

  it("mints exactly one attempt id on the server when a no-script post presents none", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSubmitGuestCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([{ command: "remove", lineId: "cli_guest_primary" }]),
      ...checkoutCommit("51", "evt_guest_primary_removed"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest_primary");
    form.set("attemptId", "short");
    form.set("intent", "remove-cart-line");

    const response = (await cartActionRequest(form, true)) as Response;

    expect(mockSubmitGuestCartCommands).toHaveBeenCalledTimes(1);
    const [, body] = mockSubmitGuestCartCommands.mock.calls[0]!;
    expect(body.attemptId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(body.attemptId).not.toBe("short");
    expect(response.status).toBe(302);
  });

  it("refuses a cart write without an owner before anything is sent", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "remove-cart-line");

    const result = await cartActionRequest(form);

    expect(result).toEqual({
      attempt: expect.objectContaining({ state: "failed-safe", attemptId: PRESENTED_ATTEMPT_ID, terminalLines: [] }),
    });
    expect(mockSubmitCartCommands).not.toHaveBeenCalled();
    expect(mockSubmitGuestCartCommands).not.toHaveBeenCalled();
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
  });

  it("resolves a lost response with exactly one lookup and redirects on the committed receipt it returns", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockRejectedValue(new TypeError("fetch failed"));
    mockGetCartCommandAttempt.mockResolvedValue(
      committedCartAttempt([{ command: "remove", lineId: "cli_primary" }], {
        eventId: "evt_attempt_recorded",
        globalPosition: "61",
      }),
    );
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "remove-cart-line");

    const response = (await cartActionRequest(form)) as Response;

    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockGetCartCommandAttempt).toHaveBeenCalledTimes(1);
    expect(mockGetCartCommandAttempt).toHaveBeenCalledWith({
      attemptId: PRESENTED_ATTEMPT_ID,
      kind: "cart.commands",
      target: "cart",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(response.status).toBe(302);
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "61",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "61", eventIds: ["evt_attempt_recorded"] }],
    });
  });

  it.each([
    ["a gateway failure", new MockCheckoutApiError(503, { error: { code: "unavailable" } })],
    ["a transport loss", new TypeError("fetch failed")],
  ])("holds %s as ambiguous after one unobserved lookup and never resends", async (_label, lost) => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockSubmitGuestCartCommands.mockRejectedValue(lost);
    mockGetGuestCartCommandAttempt.mockResolvedValue(cartAttemptResult("not-observed"));
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest_primary");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "remove-cart-line");

    const result = await cartActionRequest(form, true);

    expect(result).toEqual({
      attempt: {
        state: "ambiguous",
        intent: "remove-cart-line",
        attemptId: PRESENTED_ATTEMPT_ID,
        message: null,
        terminalLines: [],
      },
    });
    expect(mockSubmitGuestCartCommands).toHaveBeenCalledTimes(1);
    expect(mockGetGuestCartCommandAttempt).toHaveBeenCalledTimes(1);
    expect(mockGetGuestCartCommandAttempt).toHaveBeenCalledWith(
      "anon_cart_1",
      expect.objectContaining({ attemptId: PRESENTED_ATTEMPT_ID, kind: "cart.commands" }),
    );
  });

  it("returns a partial attempt with its terminal lines instead of redirecting", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "quantity", lineId: "cli_primary" },
        { command: "remove", lineId: "cli_duplicate", outcome: "conflict", message: "Cart line not found." },
      ]),
      ...checkoutCommit("70", "evt_partial"),
    });
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "2");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "update-cart-line");

    const result = await cartActionRequest(form);

    expect(result).toEqual({
      attempt: {
        state: "partial",
        intent: "update-cart-line",
        attemptId: PRESENTED_ATTEMPT_ID,
        message: null,
        terminalLines: [{ lineId: "cli_duplicate", outcome: "conflict", message: "Cart line not found." }],
      },
    });
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
  });

  it("resolves a decided refusal by the attempt it carries without a lookup", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockSubmitCartCommands.mockRejectedValue(
      new MockCheckoutApiError(409, {
        error: { code: "cart_changed", message: "Your cart changed. Review it and try again." },
        attempt: cartAttemptResult("failed-safe", { reason: "cart-changed" }),
      }),
    );
    cartAttemptClient();

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.set("attemptId", PRESENTED_ATTEMPT_ID);
    form.set("intent", "remove-cart-line");

    const result = await cartActionRequest(form);

    expect(result).toEqual({
      attempt: expect.objectContaining({
        state: "failed-safe",
        message: "Your cart changed. Review it and try again.",
        terminalLines: [],
      }),
    });
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
  });
});
