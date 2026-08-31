import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken, appendPostWriteHandoff } from "@chase-sets/http/responses";
import { registerPostWriteConsistencyRecorder } from "@chase-sets/platform-runtime/post-write-consistency";
import { ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF } from "../support/request-support/account-sell-list-handoffs";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  expectNoSellerCommitSideEffects,
  mockAcceptOfferMatch,
  mockAddGuestSellListLine,
  mockAddSellListLine,
  MockCheckoutApiError,
  mockCreateAuthRequestApiClient,
  mockCreateCheckoutRequestApiClient,
  mockCreateGuestSellListReadiness,
  mockCreateIdentityRequestApiClient,
  mockCreateListing,
  mockCreateMarketplaceRequestApiClient,
  mockDeclineOfferMatch,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockCreateSellListReadiness,
  mockGetGuestSellList,
  mockGetOfferMatch,
  mockGetPublicOffer,
  mockGetPayoutReadiness,
  MockMarketplaceApiError,
  mockMergeGuestSellListToAccount,
  mockPreviewOfferAcceptanceTerms,
  mockPreviewPublicStandardListingTerms,
  mockRemoveGuestSellListLine,
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

import { action as accountSellListAction, loader as accountSellListLoader } from "./account-sell-list";

const mockPostWriteConsistencyRecorder = vi.fn();
let unregisterPostWriteConsistencyRecorder: (() => void) | null = null;

describe("checkout web routes: account sell list", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
    unregisterPostWriteConsistencyRecorder = registerPostWriteConsistencyRecorder(mockPostWriteConsistencyRecorder);
  });

  afterEach(() => {
    unregisterPostWriteConsistencyRecorder?.();
    unregisterPostWriteConsistencyRecorder = null;
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("recovers signed-in account Sell List self-refresh when a fresh receipt times out waiting for projection freshness", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async (): Promise<never> => {
      throw new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      });
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    const request = new Request(
      `http://localhost${appendFreshWriteToken("/account/sell-list", checkoutCommit("42", "evt_checkout"))}`,
    );

    const result = await accountSellListLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    expect(mockCreateCheckoutRequestApiClient).toHaveBeenCalledWith(request);
    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [], count: 0, latestConfirmation: null },
        freshnessError: expect.any(String),
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "refreshable-catching-up",
          actorMode: "account",
          correctionSource: "fresh-read",
        }),
        offerReviews: [],
        productOfferReviews: [],
        inventoryItems: [],
      }),
    );
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "checkout",
        surface: "account-sell-list",
        strategy: "fresh-read",
        outcome: "freshness_timeout",
        routeId: "account-sell-list",
        routeTemplate: "/account/sell-list",
        correctionSource: "fresh-read",
        actorMode: "account",
        recoveryAction: "reload_prompt",
        freshnessOutcome: "valid-after-write",
      }),
    );
  });

  it("shows temporary Sell List recovery when a valid add-line handoff still reads an empty account projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list",
          checkoutCommit("42", "evt_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [], count: 0, latestConfirmation: null },
        freshnessError: expect.any(String),
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "pending-projection",
          actorMode: "account",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "checkout",
        surface: "account-sell-list",
        outcome: "handoff_pending",
        routeId: "account-sell-list",
        routeTemplate: "/account/sell-list",
        correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        actorMode: "account",
        recoveryAction: "pending_empty_state",
        freshnessOutcome: "valid-after-write",
      }),
    );
  });

  it("keeps a freshly added product Sell List line visible after the add-line handoff catches up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const productId =
      "cat_air_balloon::dim_seed_form:chc_seed_form_raw|dim_seed_condition:chc_seed_condition_damaged|dim_seed_grading_company:-|dim_seed_grade:-";
    const sellListLine = {
      seller_account_id: "acc_seller",
      line_id: "sll_air_balloon",
      line_type: "product",
      offer_id: null,
      buyer_account_id: null,
      buyer_display_name: null,
      offer_price_amount: null,
      catalog_catalog_item_id: "cat_air_balloon",
      product_id: productId,
      item_title: "Air Balloon",
      item_subtitle: "Scarlet & Violet 167/198",
      selected_options: [
        { dimensionId: "dim_seed_form", optionId: "chc_seed_form_raw" },
        { dimensionId: "dim_seed_condition", optionId: "chc_seed_condition_damaged" },
      ],
      product_summary: "Raw / Damaged",
      quantity: 1,
      fallback_mode: "none",
      minimum_listing_price_amount: null,
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    };
    const getSellList = vi.fn(async () => ({ items: [sellListLine], count: 1, latestConfirmation: null }));
    const listOfferMatches = vi.fn(async (_query: string) => ({ items: [] }));
    const listSellerListingInventory = vi.fn(async () => ({ items: [] }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
      getSellListCompositeReview: vi.fn(async () => ({
        offerReviews: [],
        productOfferReviews: [
          {
            lineId: "sll_air_balloon",
            status: "unavailable",
            offers: [],
            message: "No matching offers are currently ready for this product.",
          },
        ],
        inventoryItems: [],
      })),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list",
          checkoutCommit("42", "evt_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [sellListLine], count: 1, latestConfirmation: null },
        freshnessError: null,
        sellListRecovery: null,
        productOfferReviews: [
          {
            lineId: "sll_air_balloon",
            status: "unavailable",
            offers: [],
            message: "No matching offers are currently ready for this product.",
          },
        ],
        inventoryItems: [],
      }),
    );
    expect(listOfferMatches).not.toHaveBeenCalled();
    expect(listSellerListingInventory).not.toHaveBeenCalled();
  });

  it("hides a stale latest seller confirmation while the current confirmation is still preparing", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const staleConfirmation = {
      seller_account_id: "acc_seller",
      confirmation_id: "slc_old",
      confirmed_at: "2026-06-22T13:25:57.000Z",
      readiness_evidence: {},
      seller_evidence: {},
      handoff_summary: {
        acceptedOfferCount: 2,
        publishedListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        lineOutcomes: [],
        sideEffects: {},
      },
    };
    const getSellList = vi.fn(async () => ({ items: [], count: 0, latestConfirmation: staleConfirmation }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/sell-list?confirmation=preparing&pendingConfirmationId=slc_new",
          checkoutCommit("42", "evt_checkout_sell_list_confirmed"),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.sellList).toEqual({ items: [], count: 0, latestConfirmation: null });
    expect(result.sellListRecovery).toEqual(
      expect.objectContaining({
        kind: "pending-fresh-write",
        recoveryKind: "pending-projection",
        correctionSource: "sell-checkout-confirmation",
        freshnessOutcome: "valid-after-write",
      }),
    );
    expect(result.sellListRecovery?.message).toContain("seller confirmation");
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "checkout",
        surface: "account-sell-list",
        outcome: "handoff_pending",
        correctionSource: "sell-checkout-confirmation",
        actorMode: "account",
        recoveryAction: "pending_empty_state",
        freshnessOutcome: "valid-after-write",
      }),
    );
  });

  it("records payout-readiness handoff telemetry when a Settlement receipt returns to Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetPayoutReadiness.mockResolvedValue({
      account_id: "acc_seller",
      status: "ready",
      missing_requirements: [],
      provider_reference: "acct_stripe",
      onboarding_status: "complete",
      transfer_capability_status: "active",
      payout_capability_status: "active",
      payout_destination_status: "present",
      updated_at: "2026-05-30T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null })),
      getSellListPayoutReadiness: mockGetPayoutReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/sell-list", {
          commandReceipt: {
            mode: "eventual",
            commitPositions: [
              { sourceContextName: "settlement", maxGlobalPosition: "66", eventIds: ["evt_payout_ready"] },
            ],
            commitEventIds: [],
          },
        })}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.payoutReadiness).toEqual(expect.objectContaining({ status: "ready" }));
    expect(mockPostWriteConsistencyRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "settlement",
        surface: "payout-readiness",
        strategy: "fresh-read",
        outcome: "projection_hit",
        routeId: "account-sell-list",
        routeTemplate: "/account/sell-list",
        correctionSource: "settlement-payout-readiness",
        actorMode: "account",
        recoveryAction: "none",
        freshnessOutcome: "valid-after-write",
        sourceContextName: "settlement",
        projectionName: "settlement-payout-readiness-projection",
        readModelTable: "settlement_payout_readiness_pages",
      }),
    );
  });

  it("keeps the current seller confirmation visible once the preparing confirmation catches up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const currentConfirmation = {
      seller_account_id: "acc_seller",
      confirmation_id: "slc_current",
      confirmed_at: "2026-06-22T13:44:21.000Z",
      readiness_evidence: {},
      seller_evidence: {},
      handoff_summary: {
        acceptedOfferCount: 1,
        publishedListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        lineOutcomes: [],
        sideEffects: {},
      },
    };
    const getSellList = vi.fn(async () => ({ items: [], count: 0, latestConfirmation: currentConfirmation }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/sell-list?confirmation=preparing&pendingConfirmationId=slc_current",
          checkoutCommit("43", "evt_checkout_sell_list_confirmed"),
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.sellList.latestConfirmation).toBe(currentConfirmation);
    expect(result.sellListRecovery).toBeNull();
  });

  it("shows temporary Sell List recovery when a valid add-line handoff still reads an empty anonymous projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      getGuestSellListOfferReviews: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_1",
            status: "ready",
            comparison: null,
            message: null,
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "34.35",
              seller_net_unit_amount: "345.65",
              shipping_allowance_percentage_bps: 500,
              source_kind: "public-standard-seller-terms",
              source_label: "Standard seller terms",
              schedule_label: "Personal Default",
              source_updated_at: "2026-04-01T00:00:00.000Z",
              resolved_at: "2026-04-28T00:00:00.000Z",
            },
          },
        ],
      })),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list",
          checkoutCommit("42", "evt_guest_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        )}`,
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: {},
      context: undefined,
    } as never);

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: false,
        sellList: { items: [], count: 0 },
        freshnessError: expect.any(String),
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "pending-projection",
          actorMode: "guest",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
  });

  it("preserves guest Sell List add-line handoffs in account-gate auth links", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list",
          checkoutCommit("42", "evt_guest_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        )}`,
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.sellerCheckoutSignInHref).toContain("returnTo=");
    const signInUrl = new URL(result.sellerCheckoutSignInHref, "http://localhost");
    const returnTo = signInUrl.searchParams.get("returnTo") ?? "";
    expect(returnTo).toContain("/account/sell-list?registrationReturn=seller-checkout");
    expect(returnTo).toContain("afterWrite=");
    expect(returnTo).toContain("postWriteHandoff=");
    expect(result.sellerCheckoutRegisterHref).toContain("afterWrite");
    expect(result.sellerCheckoutRegisterHref).toContain("postWriteHandoff");
  });

  it("keeps signed-in registration returns temporary while the anonymous Sell List line is still catching up", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 0 });
    const getGuestSellList = vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList,
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list?registrationReturn=seller-checkout",
          checkoutCommit("42", "evt_guest_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        )}`,
        {
          headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
        },
      ),
      params: {},
      context: undefined,
    } as never);

    expect(getGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockMergeGuestSellListToAccount).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [], count: 0, latestConfirmation: null },
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "pending-projection",
          actorMode: "account",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
  });

  it("loads the account Sell List through the merge receipt after registration returns", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const mergeResult = {
      mergedLineCount: 1,
      commandReceipt: checkoutCommit("77", "evt_checkout_sell_list_merged"),
    };
    mockMergeGuestSellListToAccount.mockResolvedValue(mergeResult);
    const originalApi = {
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
      getGuestSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "product",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellList: vi.fn(async () => {
        throw new Error("original request should not read account Sell List after merge");
      }),
    };
    const freshApi = {
      getSellList: vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null })),
    };
    mockCreateCheckoutRequestApiClient.mockImplementation((request: Request) => {
      const url = new URL(request.url);
      return url.searchParams.has("afterWrite") && url.searchParams.has("postWriteHandoff") ? freshApi : originalApi;
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(originalApi.getSellList).not.toHaveBeenCalled();
    expect(freshApi.getSellList).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        mergedLineCount: 1,
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "pending-projection",
          actorMode: "account",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
  });

  it("continues guest Sell List handoff when sign-in returns after the anonymous projection reads empty", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const mergeResult = {
      mergedLineCount: 1,
      commandReceipt: checkoutCommit("77", "evt_checkout_sell_list_merged"),
    };
    mockMergeGuestSellListToAccount.mockResolvedValue(mergeResult);
    const originalApi = {
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
      getGuestSellList: vi.fn(async () => ({ items: [], count: 0 })),
      getSellList: vi.fn(async () => {
        throw new Error("original request should not read account Sell List after merge");
      }),
    };
    const freshApi = {
      getSellList: vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null })),
    };
    mockCreateCheckoutRequestApiClient.mockImplementation((request: Request) => {
      const url = new URL(request.url);
      return url.searchParams.has("afterWrite") && url.searchParams.has("postWriteHandoff") ? freshApi : originalApi;
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(originalApi.getGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockMergeGuestSellListToAccount).toHaveBeenCalledWith("anon_sell_1");
    expect(freshApi.getSellList).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        mergedLineCount: 1,
        sellListRecovery: expect.objectContaining({
          kind: "pending-fresh-write",
          recoveryKind: "pending-projection",
          actorMode: "account",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
  });

  it("shows actionable Sell List recovery when an expired add-line handoff still reads an empty account projection", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async () => ({ items: [], count: 0, latestConfirmation: null }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const result = await accountSellListLoader({
      request: new Request(
        `http://localhost${appendPostWriteHandoff(
          "/account/sell-list",
          checkoutCommit("42", "evt_sell_list_line"),
          ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
          Date.now() - 40_000,
        )}`,
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [], count: 0, latestConfirmation: null },
        freshnessError: expect.any(String),
        sellListRecovery: expect.objectContaining({
          kind: "missing-after-fresh-write",
          recoveryKind: "expired-handoff",
          actorMode: "account",
          freshnessOutcome: "expired-after-write",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
      }),
    );
  });

  it("treats account Sell List projection timeouts without a fresh receipt as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async (): Promise<never> => {
      throw new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      });
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });

    await expect(
      accountSellListLoader({
        request: new Request("http://localhost/account/sell-list"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("treats account Sell List projection timeouts with expired fresh receipts as permanent loader failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async (): Promise<never> => {
      throw new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      });
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/sell-list",
        checkoutCommit("42", "evt_checkout"),
        Date.now() - 40_000,
      )}`,
    );

    await expect(
      accountSellListLoader({
        request,
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("shows actionable Sell List recovery when an expired add-line handoff still hits projection freshness", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const getSellList = vi.fn(async (): Promise<never> => {
      throw new MockCheckoutApiError(503, {
        error: {
          code: "projection_freshness_timeout",
          message: "Projection read model did not catch up before the freshness timeout.",
        },
      });
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    const request = new Request(
      `http://localhost${appendPostWriteHandoff(
        "/account/sell-list",
        checkoutCommit("42", "evt_sell_list_line"),
        ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
        Date.now() - 40_000,
      )}`,
    );

    const result = await accountSellListLoader({
      request,
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        sellList: { items: [], count: 0, latestConfirmation: null },
        freshnessError: expect.any(String),
        sellListRecovery: expect.objectContaining({
          kind: "missing-after-fresh-write",
          recoveryKind: "expired-handoff",
          actorMode: "account",
          freshnessOutcome: "expired-after-write",
          correctionSource: "semantic-handoff:checkout.sell-list.add-line",
        }),
        offerReviews: [],
        productOfferReviews: [],
        inventoryItems: [],
      }),
    );
  });

  it("adds a Marketplace offer match to the Checkout-owned sell list", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_1",
      listing_id: "lst_1",
      buyer_account_id: "acc_buyer",
      buyer_display_name: "Collector123",
      price_amount: "40.00",
      catalog_catalog_item_id: "cat_mewtwo",
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      item_subtitle: "Black Star Promo 3",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      product_summary: "Raw / Near Mint",
      quantity_requested: 2,
    });
    mockAddSellListLine.mockResolvedValue({
      id: "sll_1",
      version: 1,
      status: "added",
      commandReceipt: checkoutCommit("42", "evt_sell_list_line"),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addSellListLine: mockAddSellListLine,
      getSellListOfferMatch: mockGetOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-selected-offer");
    form.set("offerId", "off_1");
    form.set("listingId", "lst_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetOfferMatch).toHaveBeenCalledWith("off_1");
    expect(mockAddSellListLine).toHaveBeenCalledWith({
      lineType: "selected-offer",
      offerId: "off_1",
      listingId: "lst_1",
      buyerAccountId: "acc_buyer",
      buyerDisplayName: "Collector123",
      offerPriceAmount: "40.00",
      catalogItemId: "cat_mewtwo",
      productId: "cat_mewtwo::raw:nm",
      itemTitle: "Mewtwo",
      itemSubtitle: "Black Star Promo 3",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw / Near Mint",
      quantity: 2,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/account/sell-list?postWriteToken=");
    expect(location).not.toContain("afterWrite=");
  });

  it("declines selected offers through Marketplace and removes selected-offer Sell List lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const removeSellListLine = vi.fn(async () => ({ status: "removed" }));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
          },
          {
            line_id: "sll_2",
            line_type: "product",
            offer_id: null,
          },
        ],
      })),
      removeSellListLine,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      declineOfferMatch: mockDeclineOfferMatch.mockResolvedValue({ status: "declined" }),
    });

    const form = new URLSearchParams();
    form.set("intent", "decline-sell-list-offers");
    form.append("bulkOfferId", "off_1");
    form.append("bulkOfferId", "off_2");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/desk/offers", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockDeclineOfferMatch).toHaveBeenNthCalledWith(1, "off_1");
    expect(mockDeclineOfferMatch).toHaveBeenNthCalledWith(2, "off_2");
    expect(removeSellListLine).toHaveBeenCalledWith("sll_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/desk/offers");
  });

  it("adds a posted selected offer snapshot to the anonymous Sell List when signed out", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockAddGuestSellListLine.mockResolvedValue({ status: "added" });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getSellListOfferMatch: mockGetOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-selected-offer");
    form.set("offerId", "off_1");
    form.set("listingId", "lst_1");
    form.set("buyerDisplayName", "Collector123");
    form.set("buyerAccountId", "acc_buyer_private");
    form.set("offerPriceAmount", "40.00");
    form.set("catalogItemId", "cat_mewtwo");
    form.set("productId", "cat_mewtwo::raw:nm");
    form.set("itemTitle", "Mewtwo");
    form.set("itemSubtitle", "Black Star Promo 3");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw / Near Mint");
    form.set("quantity", "2");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetOfferMatch).not.toHaveBeenCalled();
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith(expect.stringMatching(/^anon_/), {
      lineType: "selected-offer",
      offerId: "off_1",
      listingId: "lst_1",
      buyerAccountId: null,
      buyerDisplayName: "Collector123",
      offerPriceAmount: "40.00",
      catalogItemId: "cat_mewtwo",
      productId: "cat_mewtwo::raw:nm",
      itemTitle: "Mewtwo",
      itemSubtitle: "Black Star Promo 3",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw / Near Mint",
      quantity: 2,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_");
  });

  function expectSignedInSellCheckoutRedirect(response: Response) {
    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    const url = new URL(location ?? "", "http://localhost");
    expect(url.pathname).toMatch(/^\/checkout\/sell\/session\/chk_/);
    expect(url.searchParams.get("readinessSnapshotId")).toBe("slr_ready");
    expect(url.searchParams.get("readinessSourceRevision")).toBe("slr_source");
    return {
      url,
      readinessDecisions: JSON.parse(url.searchParams.get("readinessDecisions") ?? "{}") as Record<string, unknown>,
      sellListReviewPlan: JSON.parse(url.searchParams.get("sellListReviewPlan") ?? "{}") as Record<string, unknown>,
    };
  }

  it("starts signed-in seller checkout from Sell List readiness without sale side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const sellListLine = {
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      listing_id: "lst_1",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("offerFeeQuoteFingerprint:sll_1", "quote_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect(redirect.readinessDecisions).toEqual({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_1",
        selectedOffer: { offerId: "off_1", listingId: "lst_1", feeQuoteFingerprint: "quote_1" },
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("uses posted selected-offer fee fingerprints without Marketplace preview reads before seller checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "38.00",
      marketplace_sales_fee_unit_amount: "3.80",
      seller_net_unit_amount: "34.20",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-06-10T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockCreateSellListReadiness.mockResolvedValueOnce({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "blocked",
        includedLineIds: [],
        lineOutcomes: [{ lineId: "sll_1", outcome: "keep-in-list", reason: "stale-terms" }],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            listing_id: "lst_1",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("offerFeeQuoteFingerprint:sll_1", "guest_preview_quote");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect((result as { error: string }).error).toBe(
      "Sell List readiness must be resolved before seller checkout starts.",
    );
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_1", action: "selected-offer" }],
      lineOutcomes: [],
    });
    expectNoSellerCommitSideEffects();
  });

  it("preserves product-level Sell List Smart Match choices without accepting offers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      listing_id: "lst_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 2,
    });
    mockAcceptOfferMatch.mockResolvedValue({ status: "accepted" });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 2,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListOfferMatch: mockGetOfferMatch,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "none");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockGetOfferMatch).toHaveBeenCalledWith("off_product_1");
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect(redirect.readinessDecisions).toEqual({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_product",
        productOfferTargets: [
          {
            offerId: "off_product_1",
            listingId: "lst_product_1",
            feeQuoteFingerprint: "quote_product_1",
            quantity: 2,
          },
        ],
        fallbackListing: null,
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("preserves product fallback listing choices when no Smart Match offer is selected", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getSellListOfferMatch: mockGetOfferMatch,
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("fallbackMode:sll_product", "create-listing");
    form.set("inventoryItemId:sll_product", "inv_1");
    form.set("priceAmount:sll_product", "12.00");
    form.set("quantityCap:sll_product", "1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockGetOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_product", action: "fallback-listing" }],
      lineOutcomes: [],
    });
    expect(redirect.readinessDecisions).toEqual({
      lineActions: [{ lineId: "sll_product", action: "fallback-listing" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_product",
        productOfferTargets: [],
        fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("keeps partially resolved product lines out of seller checkout until the remainder is assigned", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      listing_id: "lst_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 2,
    });
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "blocked",
        includedLineIds: [],
        lineOutcomes: [{ lineId: "sll_product", outcome: "keep-in-list", reason: "ready", action: "smart-match" }],
      },
    });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 3,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 3 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListOfferMatch: mockGetOfferMatch,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "create-listing");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [],
      lineOutcomes: [{ lineId: "sll_product", outcome: "keep-in-list" }],
    });
    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expectNoSellerCommitSideEffects();
  });

  it("keeps unresolved Sell List readiness out of seller checkout side effects", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCreateSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_product"],
      },
    });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const result = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as { error: string };

    expect(result.error).toBe("Sell List readiness must be resolved before seller checkout starts.");
    expectNoSellerCommitSideEffects();
  });

  it("preserves fallback listing choices for seller checkout without creating listings", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetOfferMatch.mockResolvedValue({
      offer_id: "off_product_1",
      listing_id: "lst_product_1",
      product_id: "cat_mewtwo::raw:nm",
      quantity_requested: 1,
    });
    const sellListLine = {
      line_id: "sll_product",
      line_type: "product",
      offer_id: null,
      product_id: "cat_mewtwo::raw:nm",
      item_title: "Mewtwo",
      quantity: 4,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 4 })),
      createSellListReadiness: mockCreateSellListReadiness,
      getSellListOfferMatch: mockGetOfferMatch,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
      createListing: mockCreateListing,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("productOfferId:sll_product", "off_product_1");
    form.set("productOfferFeeQuoteFingerprint:sll_product:off_product_1", "quote_product_1");
    form.set("fallbackMode:sll_product", "create-listing");
    form.set("inventoryItemId:sll_product", "inv_1");
    form.set("priceAmount:sll_product", "12.00");
    form.set("quantityCap:sll_product", "1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    const redirect = expectSignedInSellCheckoutRedirect(response);
    expect(mockCreateSellListReadiness).toHaveBeenCalledWith({
      lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      lineOutcomes: [],
    });
    expect((redirect.sellListReviewPlan.lines as unknown[])[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_product",
        productOfferTargets: [
          {
            offerId: "off_product_1",
            listingId: "lst_product_1",
            feeQuoteFingerprint: "quote_product_1",
            quantity: 1,
          },
        ],
        fallbackListing: { inventoryItemId: "inv_1", priceAmount: "12.00", quantityCap: 1 },
      }),
    );
    expectNoSellerCommitSideEffects();
  });

  it("keeps payout setup out of Sell List confirmation and lets seller checkout own recovery", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockGetPayoutReadiness.mockResolvedValue({
      account_id: "acc_seller",
      status: "pending",
      missing_requirements: ["provider-onboarding"],
      provider_reference: null,
      onboarding_status: "pending",
      transfer_capability_status: "pending",
      payout_capability_status: "inactive",
      payout_destination_status: "missing",
      updated_at: "2026-05-30T00:00:00.000Z",
    });
    const sellListLine = {
      line_id: "sll_1",
      line_type: "selected-offer",
      offer_id: "off_1",
      listing_id: "lst_1",
      item_title: "Mewtwo",
      quantity: 1,
    };
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({ items: [sellListLine], count: 1 })),
      createSellListReadiness: mockCreateSellListReadiness,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      acceptOfferMatch: mockAcceptOfferMatch,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");
    form.set("offerFeeQuoteFingerprint:sll_1", "quote_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expectSignedInSellCheckoutRedirect(response);
    expect(mockGetPayoutReadiness).not.toHaveBeenCalled();
    expectNoSellerCommitSideEffects();
  });

  it("shows anonymous Sell List lines before account creation", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestSellList.mockResolvedValue({ items: [{ line_id: "sll_1", quantity: 1 }], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: false,
        registrationReturn: null,
        mergedLineCount: 0,
        mergeError: null,
        sellList: { items: [{ line_id: "sll_1", quantity: 1 }], count: 1 },
        offerReviews: [],
      }),
    );
    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
  });

  it("loads public standard terms for anonymous selected-offer Sell List lines", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockGetGuestSellList.mockResolvedValue({
      items: [
        {
          line_id: "sll_1",
          line_type: "selected-offer",
          offer_price_amount: "380.00",
          quantity: 1,
        },
      ],
      count: 1,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList,
      getGuestSellListOfferReviews: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_1",
            status: "ready",
            comparison: null,
            message: null,
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "34.35",
              seller_net_unit_amount: "345.65",
              shipping_allowance_percentage_bps: 500,
              source_kind: "public-standard-seller-terms",
              source_label: "Standard seller terms",
              schedule_label: "Personal Default",
              source_updated_at: "2026-04-01T00:00:00.000Z",
              resolved_at: "2026-04-28T00:00:00.000Z",
            },
          },
        ],
      })),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(mockPreviewPublicStandardListingTerms).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: false,
        registrationReturn: null,
        mergedLineCount: 0,
        mergeError: null,
        sellList: {
          items: [
            {
              line_id: "sll_1",
              line_type: "selected-offer",
              offer_price_amount: "380.00",
              quantity: 1,
            },
          ],
          count: 1,
        },
        offerReviews: [
          {
            lineId: "sll_1",
            status: "ready",
            comparison: null,
            message: null,
            terms: expect.not.objectContaining({
              fee_quote_fingerprint: expect.anything(),
              schedule_id: expect.anything(),
              agreement_id: expect.anything(),
            }),
          },
        ],
      }),
    );
    expect(result.offerReviews[0]?.terms).toEqual(
      expect.objectContaining({
        seller_net_unit_amount: "345.65",
        source_kind: "public-standard-seller-terms",
        source_label: "Standard seller terms",
      }),
    );
  });

  it("merges anonymous Sell List lines after registration returns to Sell List review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "38.00",
      seller_net_unit_amount: "342.00",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-04-28T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellListCompositeReview: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_1",
            status: "ready",
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "38.00",
              seller_net_unit_amount: "342.00",
              shipping_allowance_percentage_bps: 0,
              schedule_id: "terms_registered",
              agreement_id: null,
              resolved_at: "2026-04-28T00:00:00.000Z",
              fee_quote_fingerprint: "registered_quote",
            },
            comparison: {
              status: "changed",
              changedFields: ["seller-net", "marketplace-fee", "shipping-allowance"],
              standardPreview: {
                seller_net_unit_amount: "345.65",
                source_kind: "public-standard-seller-terms",
              },
            },
            message: null,
          },
        ],
        productOfferReviews: [],
        inventoryItems: [],
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.isSignedIn).toBe(true);
    expect(result.registrationReturn).toBe("seller-checkout");
    expect(result.mergedLineCount).toBe(1);
    expect(result.mergeError).toBeNull();
    expect(mockMergeGuestSellListToAccount).toHaveBeenCalledWith("anon_sell_1");
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(mockPreviewPublicStandardListingTerms).not.toHaveBeenCalled();
    expect(result.offerReviews[0]).toEqual(
      expect.objectContaining({
        lineId: "sll_1",
        status: "ready",
        terms: expect.objectContaining({ fee_quote_fingerprint: "registered_quote" }),
        comparison: expect.objectContaining({
          status: "changed",
          changedFields: ["seller-net", "marketplace-fee", "shipping-allowance"],
          standardPreview: expect.objectContaining({
            seller_net_unit_amount: "345.65",
            source_kind: "public-standard-seller-terms",
          }),
        }),
      }),
    );
  });

  it("keeps final registered terms when the standard estimate comparison is unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "38.00",
      seller_net_unit_amount: "342.00",
      shipping_allowance_percentage_bps: 0,
      schedule_id: "terms_registered",
      agreement_id: null,
      resolved_at: "2026-04-28T00:00:00.000Z",
      fee_quote_fingerprint: "registered_quote",
    });
    mockPreviewPublicStandardListingTerms.mockRejectedValue(new Error("standard terms unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellListCompositeReview: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_1",
            status: "ready",
            terms: {
              account_type: "personal",
              basis_amount: "380.00",
              marketplace_sales_fee_unit_amount: "38.00",
              seller_net_unit_amount: "342.00",
              shipping_allowance_percentage_bps: 0,
              schedule_id: "terms_registered",
              agreement_id: null,
              resolved_at: "2026-04-28T00:00:00.000Z",
              fee_quote_fingerprint: "registered_quote",
            },
            comparison: {
              status: "standard-preview-unavailable",
              standardPreview: null,
              changedFields: [],
            },
            message: null,
          },
        ],
        productOfferReviews: [],
        inventoryItems: [],
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerReviews[0]).toEqual(
      expect.objectContaining({
        status: "ready",
        terms: expect.objectContaining({ fee_quote_fingerprint: "registered_quote" }),
        comparison: {
          status: "standard-preview-unavailable",
          standardPreview: null,
          changedFields: [],
        },
      }),
    );
  });

  it("keeps selected-offer intent recoverable when final registered terms are unavailable", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockMergeGuestSellListToAccount.mockResolvedValue({ mergedLineCount: 1 });
    mockPreviewOfferAcceptanceTerms.mockRejectedValue(new Error("Offer terms are stale."));
    mockPreviewPublicStandardListingTerms.mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-04-01T00:00:00.000Z",
      resolved_at: "2026-04-28T00:00:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_1",
            line_type: "selected-offer",
            offer_id: "off_1",
            offer_price_amount: "380.00",
            item_title: "Mewtwo",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellListCompositeReview: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_1",
            status: "unavailable",
            terms: null,
            message: "Offer terms are stale.",
            comparison: {
              status: "final-unavailable",
              standardPreview: {
                seller_net_unit_amount: "345.65",
              },
              changedFields: [],
            },
          },
        ],
        productOfferReviews: [],
        inventoryItems: [],
      })),
      mergeGuestSellListToAccount: mockMergeGuestSellListToAccount,
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
      previewPublicStandardListingTerms: mockPreviewPublicStandardListingTerms,
    });

    const { loader: accountSellListLoader } = await import("./account-sell-list");
    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list?registrationReturn=seller-checkout", {
        headers: { cookie: "chase_sets_anonymous_sell_list=anon_sell_1" },
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerReviews[0]).toEqual({
      lineId: "sll_1",
      status: "unavailable",
      terms: null,
      message: "Offer terms are stale.",
      comparison: {
        status: "final-unavailable",
        standardPreview: expect.objectContaining({ seller_net_unit_amount: "345.65" }),
        changedFields: [],
      },
    });
  });

  it("resolves marketplace-wide submitted selected offers before classifying missing seller terms", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockPreviewOfferAcceptanceTerms.mockRejectedValue(new Error("Offer not found."));
    mockGetPublicOffer.mockResolvedValue({
      offer_id: "off_air_balloon",
      buyer_account_id: "acc_buyer",
      catalog_catalog_item_id: "cat_air_balloon",
      product_id: "cat_air_balloon::condition:damaged|form:raw",
      item_title: "Air Balloon",
      item_subtitle: null,
      selected_options: [
        { dimensionId: "condition", optionId: "damaged" },
        { dimensionId: "form", optionId: "raw" },
      ],
      product_summary: "Raw / Damaged",
      price_amount: "24.96",
      quantity_requested: 1,
      status: "submitted",
      accepted_seller_account_id: null,
      accepted_at: null,
      created_at: "2026-06-23T06:08:00.000Z",
      updated_at: "2026-06-23T06:08:00.000Z",
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn(async () => ({
        items: [
          {
            line_id: "sll_air_balloon",
            line_type: "selected-offer",
            offer_id: "off_air_balloon",
            buyer_account_id: "acc_buyer",
            buyer_display_name: "QA M47 Buyer 20260623 0608",
            offer_price_amount: "24.96",
            catalog_catalog_item_id: "cat_air_balloon",
            product_id: "cat_air_balloon::condition:damaged|form:raw",
            item_title: "Air Balloon",
            item_subtitle: null,
            selected_options: [
              { dimensionId: "condition", optionId: "damaged" },
              { dimensionId: "form", optionId: "raw" },
            ],
            product_summary: "Raw / Damaged",
            quantity: 1,
          },
        ],
        count: 1,
      })),
      getSellListCompositeReview: vi.fn(async () => ({
        offerReviews: [
          {
            lineId: "sll_air_balloon",
            status: "unavailable",
            terms: null,
            comparison: null,
            message: "Create a matching listing before accepting this offer.",
          },
        ],
        productOfferReviews: [],
        inventoryItems: [],
      })),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      getPublicOffer: mockGetPublicOffer,
      previewOfferAcceptanceTerms: mockPreviewOfferAcceptanceTerms,
    });

    const result = await accountSellListLoader({
      request: new Request("http://localhost/account/sell-list"),
      params: {},
      context: undefined,
    } as never);

    expect(mockGetPublicOffer).not.toHaveBeenCalled();
    expect(mockPreviewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(result.offerReviews[0]).toEqual({
      lineId: "sll_air_balloon",
      status: "unavailable",
      terms: null,
      comparison: null,
      message: "Create a matching listing before accepting this offer.",
    });
  });

  it("removes anonymous Sell List lines before sign-in", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockRemoveGuestSellListLine.mockResolvedValue({ status: "removed" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      removeGuestSellListLine: mockRemoveGuestSellListLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "remove-sell-list-line");
    form.set("lineId", "sll_1");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockRemoveGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", "sll_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/sell-list");
  });

  it("routes guest seller checkout through registration after Sell List readiness passes", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList.mockResolvedValue({ items: [], count: 0 }),
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/register?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });

  it("routes guest seller checkout to sign in when no anonymous Sell List exists", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const response = (await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
    expect(mockCreateGuestSellListReadiness).not.toHaveBeenCalled();
    expectNoSellerCommitSideEffects();
  });

  it("keeps stale guest Sell List readiness in recovery before registration", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateGuestSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "blocked",
        unresolvedLineIds: [],
        customerSafeFacts: ["Offer terms changed. Review the Sell List before seller checkout."],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList.mockResolvedValue({ items: [], count: 0 }),
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const result = await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(mockCreateGuestSellListReadiness).toHaveBeenCalledWith("anon_sell_1");
    expect(result).toEqual({ error: "Resolve Sell List readiness before seller checkout starts." });
    expectNoSellerCommitSideEffects();
  });

  it("keeps guest seller checkout in Sell List recovery when readiness is blocked", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateGuestSellListReadiness.mockResolvedValue({
      readiness: {
        ...readySellListReadinessResponse().readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["sll_1"],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestSellList: mockGetGuestSellList.mockResolvedValue({ items: [], count: 0 }),
      createGuestSellListReadiness: mockCreateGuestSellListReadiness,
    });

    const form = new URLSearchParams();
    form.set("intent", "review-sell-list-checkout");

    const result = await accountSellListAction({
      request: new Request("http://localhost/account/sell-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_sell_list=anon_sell_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(mockGetGuestSellList).toHaveBeenCalledWith("anon_sell_1");
    expect(result).toEqual({ error: "Resolve Sell List readiness before seller checkout starts." });
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockCreateListing).not.toHaveBeenCalled();
  });
});
