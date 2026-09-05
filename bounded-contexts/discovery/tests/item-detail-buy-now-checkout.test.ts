import { afterEach, describe, expect, it, vi } from "vitest";
import { readCompactPostWriteToken, readFreshWriteToken, readPostWriteHandoff } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";

import {
  mockAcceptOfferMatch,
  mockAddCartLine,
  mockAddGuestCartLine,
  mockAddGuestSellListLine,
  mockAddSellListLine,
  mockAppendAnonymousCartCookie,
  mockAppendAnonymousListingDraftCookie,
  mockAppendAnonymousProductAlertCookie,
  mockAppendAnonymousSellListCookie,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateDiscoveryRequestApiClient,
  mockCreateInventoryRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateSubmittedOffer,
  mockEnsureAnonymousCartId,
  mockEnsureAnonymousListingDraftOwnerId,
  mockEnsureAnonymousProductAlertOwnerId,
  mockEnsureAnonymousSellListId,
  mockReadAnonymousProductAlertOwnerId,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
} from "./item-detail-buy-now-test-harness";

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

vi.mock("../support/request-support/api-client", () => ({
  DiscoveryApiError: class DiscoveryApiError extends Error {},
  createDiscoveryRequestApiClient: mockCreateDiscoveryRequestApiClient,
}));

vi.mock("../support/request-support/anonymous-product-alert", () => ({
  appendAnonymousProductAlertCookie: mockAppendAnonymousProductAlertCookie,
  ensureAnonymousProductAlertOwnerId: mockEnsureAnonymousProductAlertOwnerId,
  readAnonymousProductAlertOwnerId: mockReadAnonymousProductAlertOwnerId,
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  appendAnonymousListingDraftCookie: mockAppendAnonymousListingDraftCookie,
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  ensureAnonymousListingDraftOwnerId: mockEnsureAnonymousListingDraftOwnerId,
}));

vi.mock("@chase-sets/checkout/server", () => ({
  ACCOUNT_CART_ADD_LINE_HANDOFF: {
    kind: "checkout.cart.add-line",
    expectation: "collection-non-empty",
    surface: "account-cart",
  },
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF: {
    kind: "checkout.sell-list.add-line",
    expectation: "collection-non-empty",
    surface: "account-sell-list",
  },
  appendAnonymousCartCookie: mockAppendAnonymousCartCookie,
  appendAnonymousSellListCookie: mockAppendAnonymousSellListCookie,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
  ensureAnonymousCartId: mockEnsureAnonymousCartId,
  ensureAnonymousSellListId: mockEnsureAnonymousSellListId,
}));

vi.mock("@chase-sets/inventory/server", () => ({
  createInventoryRequestApiClient: mockCreateInventoryRequestApiClient,
}));

import { action, loader } from "../routes/item-detail";

async function resolvePostWriteUrl(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return new URL(resolvedRequest.url);
}

async function readResolvedFreshWriteToken(url: URL) {
  return readFreshWriteToken(await resolvePostWriteUrl(url));
}

async function readResolvedPostWriteHandoff(url: URL) {
  return readPostWriteHandoff(await resolvePostWriteUrl(url));
}

function expectFreshWriteRedirect(response: Response, pathname: string) {
  const location = response.headers.get("Location") ?? "";
  const redirectUrl = new URL(location, "http://localhost");
  expect(redirectUrl.pathname).toBe(pathname);
  expect(redirectUrl.searchParams.has("postWriteToken")).toBe(true);
  expect(readCompactPostWriteToken(redirectUrl)).toMatch(/^pwt_/);
  expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
  expect(redirectUrl.searchParams.has("postWriteHandoff")).toBe(false);
}

async function expectSellListPostWriteRedirect(response: Response) {
  expectFreshWriteRedirect(response, "/account/sell-list");
  const location = response.headers.get("Location") ?? "";
  const redirectUrl = new URL(location, "http://localhost");
  expect(await readResolvedPostWriteHandoff(redirectUrl)).toEqual({
    kind: "checkout.sell-list.add-line",
    expectation: "collection-non-empty",
    surface: "account-sell-list",
  });
}

function activeListing(overrides: Record<string, unknown> = {}) {
  return {
    listing_id: "lst_charizard",
    status: "active",
    product_id: "cat_charizard::form:raw",
    price_amount: "380.00",
    seller_display_name: "Fresh Seller",
    quantity_cap: 3,
    visible_quantity: 3,
    created_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function commandResult<T extends { id?: string; session_id?: string }>(value: T, sourceContextName = "checkout"): T {
  const id = value.id ?? value.session_id ?? "cmd_1";
  Object.defineProperty(value, "commandReceipt", {
    value: {
      mode: "eventual",
      commitEventIds: [`evt_${id}`],
      commitPositions: [
        {
          sourceContextName,
          maxGlobalPosition: "42",
          eventIds: [`evt_${id}`],
        },
      ],
    },
    enumerable: false,
  });
  return value;
}

describe("item detail buy now checkout actions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks signed-in accounts as eligible to make offers without seller permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_account",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.canSubmitOffers).toBe(true);
    expect(result.viewerAccountId).toBe("acc_account");
    expect(result.item?.offer_demand_matches).toHaveLength(1);
  });

  it("keeps anonymous item detail offer viewing but with submission disabled", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(result.canSubmitOffers).toBe(false);
    expect(result.canUseGuestListingDraft).toBe(true);
    expect(result.viewerAccountId).toBeNull();
    expect(result.item?.offer_demand_matches).toHaveLength(1);
  });

  it("attaches display-safe public standard terms previews to item detail offers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
            price_amount: "380.00",
          },
        ],
      }),
    });
    const previewPublicStandardListingTerms = vi.fn().mockResolvedValue({
      account_type: "personal",
      basis_amount: "380.00",
      marketplace_sales_fee_unit_amount: "34.35",
      seller_net_unit_amount: "345.65",
      shipping_allowance_percentage_bps: 500,
      source_kind: "public-standard-seller-terms",
      source_label: "Standard seller terms",
      schedule_label: "Personal Default",
      source_updated_at: "2026-05-05T16:36:36.000Z",
      resolved_at: "2026-05-05T16:36:36.000Z",
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(previewPublicStandardListingTerms).toHaveBeenCalledWith({ priceAmount: "380.00" });
    const preview = result.item?.offer_demand_matches[0]?.public_standard_terms_preview;
    expect(preview).toEqual(
      expect.objectContaining({
        seller_net_unit_amount: "345.65",
        marketplace_sales_fee_unit_amount: "34.35",
        source_label: "Standard seller terms",
      }),
    );
    expect("fee_quote_fingerprint" in (preview ?? {})).toBe(false);
    expect("schedule_id" in (preview ?? {})).toBe(false);
    expect("agreement_id" in (preview ?? {})).toBe(false);
  });

  it("skips public standard terms previews for registered viewers", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [],
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            catalog_catalog_item_id: "cat_charizard",
            status: "submitted",
            price_amount: "380.00",
          },
        ],
      }),
    });
    const previewPublicStandardListingTerms = vi.fn();
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      previewPublicStandardListingTerms,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await loader({
      request: new Request("http://localhost/items/charizard-base-set"),
      params: { id: "charizard-base-set" },
      context: {},
    } as never);

    expect(previewPublicStandardListingTerms).not.toHaveBeenCalled();
    expect(result.item?.offer_demand_matches[0]?.public_standard_terms_preview).toBeUndefined();
  });

  it("hands product offer intent to checkout without seller permissions", async () => {
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createSubmittedOffer: mockCreateSubmittedOffer.mockResolvedValue({
        offer_id: "offer_charizard",
      }),
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("priceAmount", "350.00");
    form.set("quantityRequested", "1");
    form.set("shippingName", "Jane Smith");
    form.set("shippingLine1", "100 Market Street");
    form.set("shippingCity", "Chicago");
    form.set("shippingState", "IL");
    form.set("shippingPostalCode", "60601");
    form.set("shippingCountry", "US");

    const response = (await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    } as never)) as Response;

    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location")!, "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/buy/readiness");
    expect(redirectUrl.searchParams.get("source")).toBe("offer-intent");
    expect(redirectUrl.searchParams.get("catalogItemId")).toBe("cat_charizard");
    expect(redirectUrl.searchParams.get("productId")).toBe("cat_charizard::form:raw");
    expect(redirectUrl.searchParams.get("itemTitle")).toBe("Charizard");
    expect(redirectUrl.searchParams.get("selectedOptions")).toBe(
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    expect(redirectUrl.searchParams.get("productSummary")).toBe("Raw");
    expect(redirectUrl.searchParams.get("offerPriceAmount")).toBe("350.00");
    expect(redirectUrl.searchParams.get("quantity")).toBe("1");
  });

  it("lets signed-out buyers start purchase intent checkout with normalized draft values before registration", async () => {
    const signInRedirect = new Response(null, {
      status: 302,
      headers: { Location: "/sign-in?returnTo=%2Fitems%2Fcharizard-base-set" },
    });
    mockRequireActorFromAuthApi.mockRejectedValue(signInRedirect);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        slug: "charizard-base-set",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      createSubmittedOffer: mockCreateSubmittedOffer,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const form = new URLSearchParams();
    form.set("intent", "submit-offer");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("priceAmount", "350");
    form.set("quantityRequested", "2");

    const response = (await action({
      request: new Request("http://localhost/items/charizard-base-set", {
        method: "POST",
        body: form,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
      params: { id: "charizard-base-set" },
      context: {},
    } as never)) as Response;

    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location")!, "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/buy/readiness");
    expect(redirectUrl.searchParams.get("source")).toBe("offer-intent");
    expect(redirectUrl.searchParams.get("productId")).toBe("cat_charizard::form:raw");
    expect(redirectUrl.searchParams.get("selectedOptions")).toBe(
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    expect(redirectUrl.searchParams.get("productSummary")).toBe("Raw");
    expect(redirectUrl.searchParams.get("offerPriceAmount")).toBe("350.00");
    expect(redirectUrl.searchParams.get("quantity")).toBe("2");
    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockCreateSubmittedOffer).not.toHaveBeenCalled();
  });

  it("creates a seller-locked listing checkout session and redirects to checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [activeListing()],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession.mockResolvedValue(
        commandResult({
          session_id: "chk_buy_now",
        }),
      ),
      addCartLine: mockAddCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("lockedListingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: expect.stringMatching(/^chkentry_[0-9a-f]{32}$/),
      source: {
        type: "buy-now",
        listingId: "lst_charizard",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set 4/102 Holo Rare",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_charizard",
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expectFreshWriteRedirect(response, "/checkout/buy/session/chk_buy_now");
    expect(mockAddCartLine).not.toHaveBeenCalled();

    const firstEntryAttemptKey = mockCreateCheckoutSession.mock.calls[0]?.[0]?.entryAttemptKey;
    const secondResponse = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(secondResponse.status).toBe(302);
    expect(mockCreateCheckoutSession.mock.calls[1]?.[0]?.entryAttemptKey).toBe(firstEntryAttemptKey);
  });

  it("adds selected products to the checkout cart without creating a session", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue(commandResult({ id: "cli_1", version: 1, status: "active" })),
      createCheckoutSession: mockCreateCheckoutSession,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith({
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      itemImageUrl: null,
      itemImageSrcSet: null,
      itemImageLoadingUrl: null,
      itemImageLoadingAlt: null,
      itemImageLoadingSrcSet: null,
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      selectedListingSnapshot: null,
      quantity: 2,
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const addedToCart = (await response.json()) as { viewCartHref: string };
    expect(addedToCart).toMatchObject({
      status: "added-to-cart",
      itemTitle: "Charizard",
      quantity: 2,
      cartLine: {
        id: "cli_1",
        version: 1,
        status: "active",
      },
    });
    const viewCartUrl = new URL(addedToCart.viewCartHref, "http://localhost");
    expect(viewCartUrl.pathname).toBe("/account/cart");
    expect(viewCartUrl.searchParams.has("postWriteToken")).toBe(true);
    expect(viewCartUrl.searchParams.has("afterWrite")).toBe(false);
    expect(await readResolvedFreshWriteToken(viewCartUrl)).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cli_1"] }],
    });
    expect(await readResolvedPostWriteHandoff(viewCartUrl)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
  });

  it("omits fresh-write and semantic handoff metadata when add-to-cart returns no command receipt", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue({ id: "cli_1", version: 1, status: "active" }),
      createCheckoutSession: mockCreateCheckoutSession,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(200);
    const addedToCart = (await response.json()) as { viewCartHref: string };
    const viewCartUrl = new URL(addedToCart.viewCartHref, "http://localhost");

    expect(viewCartUrl.pathname).toBe("/account/cart");
    expect(viewCartUrl.searchParams.has("afterWrite")).toBe(false);
    expect(viewCartUrl.searchParams.has("postWriteHandoff")).toBe(false);
    expect(readFreshWriteToken(viewCartUrl)).toBeNull();
    expect(readPostWriteHandoff(viewCartUrl)).toBeNull();
  });

  it("adds an explicitly selected listing to the account Buy Cart as a locked-listing line", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            account_id: "acc_card_vault",
            product_id: "cat_charizard::form:raw",
            status: "active",
            price_amount: "380.00",
            seller_display_name: "Card Vault",
            seller_slug: "card-vault",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue(commandResult({ id: "cli_1", version: 1, status: "active" })),
      addGuestCartLine: mockAddGuestCartLine,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("sellerPreferenceId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_charizard",
        sellerPreferenceId: "lst_charizard",
        selectedListingSnapshot: {
          listingId: "lst_charizard",
          sellerAccountId: "acc_card_vault",
          sellerDisplayName: "Card Vault",
          sellerSlug: "card-vault",
          priceAmount: "380.00",
          source: "discovery.item-detail.add-to-cart",
        },
        quantity: 2,
      }),
    );
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("adds an explicitly selected listing to the guest Buy Cart as a locked-listing line", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            account_id: "acc_card_vault",
            product_id: "cat_charizard::form:raw",
            status: "active",
            price_amount: "380.00",
            seller_display_name: "Card Vault",
            seller_slug: "card-vault",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine.mockResolvedValue(
        commandResult({ id: "cli_1", version: 1, status: "active" }),
      ),
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("sellerPreferenceId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddGuestCartLine).toHaveBeenCalledWith(
      "anon_cart_1",
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_charizard",
        sellerPreferenceId: "lst_charizard",
        selectedListingSnapshot: {
          listingId: "lst_charizard",
          sellerAccountId: "acc_card_vault",
          sellerDisplayName: "Card Vault",
          sellerSlug: "card-vault",
          priceAmount: "380.00",
          source: "discovery.item-detail.add-to-cart",
        },
        quantity: 2,
      }),
    );
    expect(mockAddCartLine).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("adds selected products to the Checkout-owned Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addSellListLine: mockAddSellListLine.mockResolvedValue(
        commandResult({ id: "sll_1", version: 1, status: "active" }),
      ),
    });

    const form = new URLSearchParams();
    form.set("intent", "add-product-to-sell-list");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "3");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockResolveActorFromAuthApi).toHaveBeenCalledWith({
      request: expect.any(Request),
    });
    expect(mockAddSellListLine).toHaveBeenCalledWith({
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 3,
    });
    expect(response.status).toBe(302);
    await expectSellListPostWriteRedirect(response);
  });

  it("adds signed-out product seller intent to an anonymous Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine.mockResolvedValue(
        commandResult({ id: "sll_1", version: 1, status: "active" }),
      ),
    });

    const form = new URLSearchParams();
    form.set("intent", "add-product-to-sell-list");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
    } as never)) as Response;

    expect(mockEnsureAnonymousSellListId).toHaveBeenCalledWith(expect.any(Request));
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", {
      lineType: "product",
      offerId: null,
      buyerAccountId: null,
      buyerDisplayName: null,
      offerPriceAmount: null,
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 2,
    });
    expect(mockAppendAnonymousSellListCookie).toHaveBeenCalledWith(
      expect.any(Headers),
      "anon_sell_1",
      expect.any(Request),
    );
    expect(response.status).toBe(302);
    await expectSellListPostWriteRedirect(response);
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_sell_1");
  });

  it("adds signed-out selected offer seller intent to an anonymous Sell List", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            buyer_account_id: "acc_buyer_private",
            buyer_display_name: "Top Loader Capital",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::form:raw",
            item_title: "Charizard",
            item_subtitle: "Base Set 4/102 Holo Rare",
            selected_options: [{ dimensionId: "form", optionId: "raw" }],
            product_summary: "Raw",
            price_amount: "380.00",
            quantity_requested: 1,
            status: "submitted",
            accepted_seller_account_id: null,
            accepted_at: null,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine.mockResolvedValue(
        commandResult({ id: "sll_1", version: 1, status: "active" }),
      ),
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-sell-list");
    form.set("offerId", "offer_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
    } as never)) as Response;

    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockEnsureAnonymousSellListId).toHaveBeenCalledWith(expect.any(Request));
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", {
      lineType: "selected-offer",
      offerId: "offer_charizard",
      buyerAccountId: null,
      buyerDisplayName: "Top Loader Capital",
      offerPriceAmount: "380.00",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 1,
    });
    expect(response.status).toBe(302);
    await expectSellListPostWriteRedirect(response);
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_sell_1");
  });

  for (const { intent, name } of [
    {
      intent: "add-to-sell-list",
      name: "adds signed-in selected offer seller intent to the account Sell List",
    },
    {
      intent: "sell-now",
      name: "routes signed-in selected offer acceptance through account Sell List review",
    },
  ] as const) {
    it(name, async () => {
      mockResolveActorFromAuthApi.mockResolvedValue({
        accountId: "acc_seller",
        permissions: ["offers.manage", "offers.view", "listings.view"],
      });
      mockRequireActorFromAuthApi.mockResolvedValue({
        accountId: "acc_seller",
        permissions: ["offers.manage", "offers.view", "listings.view"],
      });
      mockCreateDiscoveryRequestApiClient.mockReturnValue({
        getItemDetail: vi.fn().mockResolvedValue({
          catalog_item_id: "cat_charizard",
          title: "Charizard",
          subtitle: "Base Set 4/102 Holo Rare",
          offer_demand_matches: [
            {
              offer_id: "offer_charizard",
              buyer_account_id: "acc_buyer_private",
              buyer_display_name: "Top Loader Capital",
              catalog_catalog_item_id: "cat_charizard",
              product_id: "cat_charizard::form:raw",
              item_title: "Charizard",
              item_subtitle: "Base Set 4/102 Holo Rare",
              selected_options: [{ dimensionId: "form", optionId: "raw" }],
              product_summary: "Raw",
              price_amount: "380.00",
              quantity_requested: 1,
              status: "submitted",
              accepted_seller_account_id: null,
              accepted_at: null,
            },
          ],
        }),
      });
      mockCreateMarketplaceRequestApiClient.mockReturnValue({
        acceptOfferMatch: mockAcceptOfferMatch,
      });
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        addSellListLine: mockAddSellListLine.mockResolvedValue(
          commandResult({ id: "sll_1", version: 1, status: "active" }),
        ),
      });

      const form = new URLSearchParams();
      form.set("intent", intent);
      form.set("offerId", "offer_charizard");

      const response = (await action({
        request: new Request("http://localhost/items/cat_charizard", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { id: "cat_charizard" },
      } as never)) as Response;

      expect(mockRequireActorFromAuthApi).toHaveBeenCalledWith({
        request: expect.any(Request),
        permission: "offers.manage",
      });
      expect(mockEnsureAnonymousSellListId).not.toHaveBeenCalled();
      expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
      expect(mockAddSellListLine).toHaveBeenCalledWith({
        lineType: "selected-offer",
        offerId: "offer_charizard",
        buyerAccountId: null,
        buyerDisplayName: "Top Loader Capital",
        offerPriceAmount: "380.00",
        catalogItemId: "cat_charizard",
        productId: "cat_charizard::form:raw",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set 4/102 Holo Rare",
        selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
        productSummary: "Raw",
        fallbackMode: "none",
        minimumListingPriceAmount: null,
        quantity: 1,
      });
      expect(response.status).toBe(302);
      await expectSellListPostWriteRedirect(response);
      expect(response.headers.getSetCookie().join("; ")).not.toContain("chase_sets_anonymous_sell_list=");
    });
  }

  it("routes signed-out selected offer acceptance through anonymous Sell List review", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        offer_demand_matches: [
          {
            offer_id: "offer_charizard",
            buyer_account_id: "acc_buyer_private",
            buyer_display_name: "Top Loader Capital",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::form:raw",
            item_title: "Charizard",
            item_subtitle: "Base Set 4/102 Holo Rare",
            selected_options: [{ dimensionId: "form", optionId: "raw" }],
            product_summary: "Raw",
            price_amount: "380.00",
            quantity_requested: 1,
            status: "submitted",
            accepted_seller_account_id: null,
            accepted_at: null,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({
      acceptOfferMatch: mockAcceptOfferMatch,
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addGuestSellListLine: mockAddGuestSellListLine.mockResolvedValue(
        commandResult({ id: "sll_1", version: 1, status: "active" }),
      ),
    });

    const form = new URLSearchParams();
    form.set("intent", "sell-now");
    form.set("offerId", "offer_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
    } as never)) as Response;

    expect(mockRequireActorFromAuthApi).not.toHaveBeenCalled();
    expect(mockAcceptOfferMatch).not.toHaveBeenCalled();
    expect(mockEnsureAnonymousSellListId).toHaveBeenCalledWith(expect.any(Request));
    expect(mockAddGuestSellListLine).toHaveBeenCalledWith("anon_sell_1", {
      lineType: "selected-offer",
      offerId: "offer_charizard",
      buyerAccountId: null,
      buyerDisplayName: "Top Loader Capital",
      offerPriceAmount: "380.00",
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fallbackMode: "none",
      minimumListingPriceAmount: null,
      quantity: 1,
    });
    expect(response.status).toBe(302);
    await expectSellListPostWriteRedirect(response);
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_sell_list=anon_sell_1");
  });

  it("hands signed-out seller-locked checkout to Checkout with a method-preserving redirect", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [activeListing()],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");
    form.set("lockedListingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const location = response.headers.get("Location") ?? "";
    const redirectUrl = new URL(location, "http://localhost");

    expect(response.status).toBe(307);
    expect(redirectUrl.pathname).toBe("/checkout/buy/readiness");
    expect(redirectUrl.searchParams.get("source")).toBe("buy-now");
    expect(redirectUrl.searchParams.get("listingId")).toBe("lst_charizard");
    expect(redirectUrl.searchParams.get("fulfillmentMode")).toBe("locked-listing");
    expect(redirectUrl.searchParams.get("lockedListingId")).toBe("lst_charizard");
    expect(redirectUrl.searchParams.get("catalogItemId")).toBe("cat_charizard");
    expect(redirectUrl.searchParams.get("productId")).toBe("cat_charizard::form:raw");
    expect(redirectUrl.searchParams.get("itemTitle")).toBe("Charizard");
    expect(redirectUrl.searchParams.get("itemSubtitle")).toBe("Base Set 4/102 Holo Rare");
    expect(redirectUrl.searchParams.get("selectedOptions")).toBe(
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
    );
    expect(redirectUrl.searchParams.get("productSummary")).toBe("Raw");
    expect(redirectUrl.searchParams.get("quantity")).toBe("2");
    expect(redirectUrl.searchParams.get("priceAmount")).toBe("380.00");
    expect(redirectUrl.searchParams.get("sellerName")).toBe("Fresh Seller");
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses the fresh listing snapshot for signed-out locked-listing checkout handoffs", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            status: "active",
            price_amount: "380.00",
            seller_display_name: "Fresh Seller",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");
    form.set("lockedListingId", "lst_charizard");
    form.set("priceAmount", "1.00");
    form.set("sellerName", "Tampered Seller");
    form.set("availability", "999 available");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(response.status).toBe(307);
    expect(redirectUrl.pathname).toBe("/checkout/buy/readiness");
    expect(redirectUrl.searchParams.get("fulfillmentMode")).toBe("locked-listing");
    expect(redirectUrl.searchParams.get("lockedListingId")).toBe("lst_charizard");
    expect(redirectUrl.searchParams.get("priceAmount")).toBe("380.00");
    expect(redirectUrl.searchParams.get("sellerName")).toBe("Fresh Seller");
    expect(redirectUrl.searchParams.get("availability")).toBe("Raw - 2 available");
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("adds signed-out cart lines to the anonymous server cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine.mockResolvedValue(
        commandResult({ id: "cli_1", version: 1, status: "active" }),
      ),
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddGuestCartLine).toHaveBeenCalledWith("anon_cart_1", {
      catalogItemId: "cat_charizard",
      productId: "cat_charizard::form:raw",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set 4/102 Holo Rare",
      itemImageUrl: null,
      itemImageSrcSet: null,
      itemImageLoadingUrl: null,
      itemImageLoadingAlt: null,
      itemImageLoadingSrcSet: null,
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      productSummary: "Raw",
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      selectedListingSnapshot: null,
      quantity: 2,
    });
    expect(mockAppendAnonymousCartCookie).toHaveBeenCalledWith(response.headers, "anon_cart_1", expect.any(Request));
    expect(mockAddCartLine).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const addedToCart = (await response.json()) as { viewCartHref: string };
    expect(addedToCart).toMatchObject({
      status: "added-to-cart",
      itemTitle: "Charizard",
      quantity: 2,
      cartLine: {
        id: "cli_1",
        version: 1,
        status: "active",
      },
    });
    const viewCartUrl = new URL(addedToCart.viewCartHref, "http://localhost");
    expect(viewCartUrl.pathname).toBe("/account/cart");
    expect(viewCartUrl.searchParams.has("postWriteToken")).toBe(true);
    expect(viewCartUrl.searchParams.has("afterWrite")).toBe(false);
    expect(await readResolvedFreshWriteToken(viewCartUrl)).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cli_1"] }],
    });
    expect(await readResolvedPostWriteHandoff(viewCartUrl)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
  });

  it("sends signed-out best-match buyers to the anonymous Buy Cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [activeListing()],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine.mockResolvedValue(
        commandResult({ id: "cli_1", version: 1, status: "active" }),
      ),
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-best-match");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddGuestCartLine).toHaveBeenCalledWith(
      "anon_cart_1",
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        lockedListingId: null,
        sellerPreferenceId: null,
        quantity: 1,
      }),
    );
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockAppendAnonymousCartCookie).toHaveBeenCalledWith(response.headers, "anon_cart_1", expect.any(Request));
    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/account/cart");
    expect(redirectUrl.searchParams.has("postWriteToken")).toBe(true);
    expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
    expect(await readResolvedFreshWriteToken(redirectUrl)).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cli_1"] }],
    });
    expect(await readResolvedPostWriteHandoff(redirectUrl)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
  });

  it("adds signed-in buyer cart lines to the account cart without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [activeListing()],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      addCartLine: mockAddCartLine.mockResolvedValue(commandResult({ id: "cli_1", version: 1, status: "active" })),
      addGuestCartLine: mockAddGuestCartLine,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("intent", "add-to-cart");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        quantity: 1,
      }),
    );
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
    expect(mockAppendAnonymousCartCookie).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("sends signed-in best-match buyers to Buy Cart without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [activeListing()],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      addCartLine: mockAddCartLine.mockResolvedValue(commandResult({ id: "cli_1", version: 1, status: "active" })),
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-best-match");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockAddCartLine).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "cat_charizard::form:raw",
        fulfillmentMode: "optimize",
        lockedListingId: null,
        sellerPreferenceId: null,
        quantity: 1,
      }),
    );
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/account/cart");
    expect(redirectUrl.searchParams.has("postWriteToken")).toBe(true);
    expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
    expect(await readResolvedFreshWriteToken(redirectUrl)).toMatchObject({
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_cli_1"] }],
    });
    expect(await readResolvedPostWriteHandoff(redirectUrl)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
  });

  it("creates seller-locked buy-now sessions for signed-in buyers without order-management permissions", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: [],
    });
    mockCreateDiscoveryRequestApiClient.mockReturnValue({
      getItemDetail: vi.fn().mockResolvedValue({
        catalog_item_id: "cat_charizard",
        title: "Charizard",
        subtitle: "Base Set 4/102 Holo Rare",
        market_listings: [
          {
            listing_id: "lst_charizard",
            status: "active",
            quantity_cap: 2,
            visible_quantity: 2,
          },
        ],
      }),
    });
    mockCreateMarketplaceRequestApiClient.mockReturnValue({});
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession.mockResolvedValue(
        commandResult({
          session_id: "chk_locked",
        }),
      ),
      addCartLine: mockAddCartLine,
      addGuestCartLine: mockAddGuestCartLine,
    });

    const form = new URLSearchParams();
    form.set("intent", "buy-this-listing");
    form.set("productId", "cat_charizard::form:raw");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "form", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "1");
    form.set("lockedListingId", "lst_charizard");

    const response = (await action({
      request: new Request("http://localhost/items/cat_charizard", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { id: "cat_charizard" },
      context: undefined,
    } as never)) as Response;

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: expect.stringMatching(/^chkentry_[0-9a-f]{32}$/),
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_charizard",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_charizard",
        quantity: 1,
      }),
    });
    expect(response.status).toBe(302);
    expectFreshWriteRedirect(response, "/checkout/buy/session/chk_locked");
    expect(mockAddGuestCartLine).not.toHaveBeenCalled();
  });
});
