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
  mockRemoveCartLine,
  mockRemoveGuestCartLine,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockUpdateCartLineFulfillment,
  mockUpdateCartLineQuantity,
  mockUpdateGuestCartLineFulfillment,
  mockUpdateGuestCartLineQuantity,
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

  it("updates the primary grouped cart line and removes duplicate line ids", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    let resolveQuantityWrite!: (value: unknown) => void;
    mockUpdateCartLineQuantity.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuantityWrite = resolve;
        }),
    );
    mockRemoveCartLine.mockResolvedValue(checkoutCommit("44", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineQuantity: mockUpdateCartLineQuantity,
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "2");
    form.set("quantityDelta", "1");
    form.set("intent", "update-cart-line");

    const actionPromise = accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockUpdateCartLineQuantity).toHaveBeenCalledWith("cli_primary", { quantity: 3 });
    expect(mockRemoveCartLine).not.toHaveBeenCalled();

    resolveQuantityWrite(checkoutCommit("43", "evt_quantity"));
    const response = (await actionPromise) as Response;

    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "44",
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "44",
          eventIds: ["evt_quantity", "evt_duplicate_removed"],
        },
      ],
    });
  });

  it("uses absolute optimistic quantity for signed-in grouped cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockUpdateCartLineQuantity.mockResolvedValue(checkoutCommit("48", "evt_quantity"));
    mockRemoveCartLine.mockResolvedValue(checkoutCommit("49", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineQuantity: mockUpdateCartLineQuantity,
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("quantity", "5");
    form.set("quantityDelta", "-1");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("optimisticSequence", "3");
    form.set("intent", "update-cart-line");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateCartLineQuantity).toHaveBeenCalledWith("cli_primary", { quantity: 5 });
    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(mockUpdateCartLineQuantity.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveCartLine.mock.invocationCallOrder[0] ?? 0,
    );
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
  });

  it("uses absolute optimistic quantity for guest cart updates", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockUpdateGuestCartLineQuantity.mockResolvedValue(checkoutCommit("50", "evt_guest_quantity"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateGuestCartLineQuantity: mockUpdateGuestCartLineQuantity,
      removeGuestCartLine: mockRemoveGuestCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("quantity", "4");
    form.set("optimisticStrategy", "optimistic-with-correction");
    form.set("correctionSource", "fresh-read:loader-revalidation");
    form.set("optimisticSequence", "2");
    form.set("intent", "update-cart-line");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateGuestCartLineQuantity).toHaveBeenCalledWith("anon_cart_1", "cli_guest", { quantity: 4 });
    expect(mockRemoveGuestCartLine).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
  });

  it("locks preferred listing fulfillment for signed-in grouped cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockUpdateCartLineFulfillment
      .mockResolvedValueOnce(checkoutCommit("45", "evt_primary_locked"))
      .mockResolvedValueOnce(checkoutCommit("46", "evt_duplicate_locked"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateCartLineFulfillment: mockUpdateCartLineFulfillment,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("intent", "lock-preferred-listing");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateCartLineFulfillment).toHaveBeenCalledWith("cli_primary", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(mockUpdateCartLineFulfillment).toHaveBeenCalledWith("cli_duplicate", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(mockUpdateCartLineFulfillment.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateCartLineFulfillment.mock.invocationCallOrder[1] ?? 0,
    );
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "46",
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "46",
          eventIds: ["evt_primary_locked", "evt_duplicate_locked"],
        },
      ],
    });
  });

  it("locks preferred listing fulfillment for guest cart lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockUpdateGuestCartLineFulfillment.mockResolvedValue(checkoutCommit("47", "evt_guest_locked"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      updateGuestCartLineFulfillment: mockUpdateGuestCartLineFulfillment,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest");
    form.set("sellerPreferenceId", "lst_card_vault");
    form.set("intent", "lock-preferred-listing");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockUpdateGuestCartLineFulfillment).toHaveBeenCalledWith("anon_cart_1", "cli_guest", {
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_card_vault",
      sellerPreferenceId: "lst_card_vault",
      availabilityState: "available",
    });
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "47",
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "47", eventIds: ["evt_guest_locked"] }],
    });
  });

  it("removes every grouped cart line id from the simplified cart page", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockRemoveCartLine
      .mockResolvedValueOnce(checkoutCommit("45", "evt_primary_removed"))
      .mockResolvedValueOnce(checkoutCommit("46", "evt_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      removeCartLine: mockRemoveCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_primary");
    form.append("lineId", "cli_duplicate");
    form.set("intent", "remove-cart-line");

    const response = (await accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_primary");
    expect(mockRemoveCartLine).toHaveBeenCalledWith("cli_duplicate");
    expect(mockRemoveCartLine.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveCartLine.mock.invocationCallOrder[1] ?? 0,
    );
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "46",
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "46",
          eventIds: ["evt_primary_removed", "evt_duplicate_removed"],
        },
      ],
    });
  });

  it("removes grouped guest cart lines in order and preserves every fresh-write receipt", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    let resolvePrimaryRemove!: (value: unknown) => void;
    mockRemoveGuestCartLine
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePrimaryRemove = resolve;
          }),
      )
      .mockResolvedValueOnce(checkoutCommit("52", "evt_guest_duplicate_removed"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      removeGuestCartLine: mockRemoveGuestCartLine,
    });

    const form = new URLSearchParams();
    form.append("lineId", "cli_guest_primary");
    form.append("lineId", "cli_guest_duplicate");
    form.set("intent", "remove-cart-line");

    const actionPromise = accountCartAction({
      request: new Request("http://localhost/account/cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRemoveGuestCartLine).toHaveBeenCalledWith("anon_cart_1", "cli_guest_primary");
    expect(mockRemoveGuestCartLine).not.toHaveBeenCalledWith("anon_cart_1", "cli_guest_duplicate");

    resolvePrimaryRemove(checkoutCommit("51", "evt_guest_primary_removed"));
    const response = (await actionPromise) as Response;

    expect(mockRemoveGuestCartLine).toHaveBeenCalledWith("anon_cart_1", "cli_guest_duplicate");
    expect(response.status).toBe(302);
    expectCompactPostWriteLocation(response.headers.get("Location"), "/account/cart?postWriteToken=");
    await expect(readResolvedFreshWriteToken(response.headers.get("Location"))).resolves.toMatchObject({
      commitPosition: "52",
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "52",
          eventIds: ["evt_guest_primary_removed", "evt_guest_duplicate_removed"],
        },
      ],
    });
  });
});
