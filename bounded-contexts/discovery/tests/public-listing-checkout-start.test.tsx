// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, type RouteObject } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryPublicListing } from "../support/client-support/contracts";
import {
  dispatchPersistedPageShow,
  expectDocument,
  FakeEventSource,
  hiddenEntryKey,
  hydrateDocument,
  loaderEntryKey,
  serverRender,
  SYNC_REQUIRED,
  unhydratedFormSubmission,
  type HydratedDocument,
  type ServerDocument,
} from "./entry-attempt-key-harness";

const mocks = vi.hoisted(() => ({ getPublicListingBySlug: vi.fn() }));

vi.mock("../support/request-support/api-client", () => ({
  DiscoveryApiError: class DiscoveryApiError extends Error {},
  createDiscoveryRequestApiClient: () => ({ getPublicListingBySlug: mocks.getPublicListingBySlug }),
}));

import PublicListingRoute, { action, loader } from "../routes/public-listing";

const LISTING_PATH = "/listings/charizard-lst_1";
const BUY_FORM = 'form[action^="/checkout/buy/readiness"]';
const routes: RouteObject[] = [
  { id: "public-listing", path: "/listings/:listingSlug", loader, action, Component: PublicListingRoute },
  { id: "other", path: "/other", Component: () => <p>Another page</p> },
];

let mounted: HydratedDocument | null = null;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mocks.getPublicListingBySlug.mockResolvedValue(publicListing());
});

afterEach(() => {
  cleanup();
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function open(path = LISTING_PATH) {
  return expectDocument(await serverRender(routes, new Request(`http://localhost${path}`)));
}

async function show(served: ServerDocument) {
  mounted?.unmount();
  mounted = await hydrateDocument(served, routes);
  return mounted;
}

function currentLoaderKey(page: HydratedDocument) {
  return (page.router.state.loaderData["public-listing"] as { entryAttemptKey?: string } | undefined)?.entryAttemptKey;
}

function expectBuyPostForwards(submission: ReturnType<typeof unhydratedFormSubmission>, entryAttemptKey: string) {
  expect(submission.method).toBe("post");
  expect(submission.action.pathname).toBe("/checkout/buy/readiness");
  expect(submission.body.get("entryAttemptKey")).toBe(entryAttemptKey);
}

describe("public listing checkout start", () => {
  it("renders Buy as a server POST form to the complete Checkout source URL", async () => {
    const Stub = createRoutesStub([{ path: "/listings/:listingSlug", Component: PublicListingRoute, loader }]);

    render(<Stub initialEntries={[LISTING_PATH]} />);

    const buyButton = await screen.findByRole("button", { name: "Buy this listing" });
    const buyForm = buyButton.closest("form");
    expect(buyForm).not.toBeNull();
    expect(buyForm?.method).toBe("post");
    expect(screen.queryByRole("link", { name: "Buy this listing" })).toBeNull();

    const action = new URL(buyForm?.action ?? "", "http://localhost");
    expect(action.pathname).toBe("/checkout/buy/readiness");
    expect(Object.fromEntries(action.searchParams)).toMatchObject({
      source: "buy-now",
      listingId: "lst_1",
      fulfillmentMode: "locked-listing",
      lockedListingId: "lst_1",
      catalogItemId: "cit_1",
      productId: "prd_1",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]),
      productSummary: "Near Mint",
      quantity: "1",
      priceAmount: "42.00",
      priceCurrencyCode: "EUR",
      sellerName: "Card Vault",
    });

    const reportButton = screen.getByRole("button", { name: "Report listing" });
    expect(reportButton.closest("form")).not.toBe(buyForm);
  });

  it("AC4 carries the loader key in the server HTML and the unhydrated Buy post to Checkout start", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "public-listing")!;
    expect(pageViewKey).toMatch(/^chkentry_[0-9A-Z]{26}$/);

    const selectors = { form: BUY_FORM, submitter: 'button[type="submit"]' };
    expectBuyPostForwards(unhydratedFormSubmission(served.html, selectors), pageViewKey);

    // Planted control: the same evidence fails for a keyless Buy form.
    const keyless = unhydratedFormSubmission(served.html, selectors, (form) =>
      form.querySelector('input[name="entryAttemptKey"]')?.remove(),
    );
    expect(keyless.body.has("entryAttemptKey")).toBe(false);
    expect(() => expectBuyPostForwards(keyless, pageViewKey)).toThrow();
  });

  it("AC3 keeps the key across a realtime revalidation remount, a persisted pageshow, re-hydration and a router back across a same-page search", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "public-listing")!;
    let page = await show(served);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    // Display fields and updated_at change: the realtime view is keyed by updated_at, so it remounts.
    const beforeRemount = page.container.querySelector<HTMLFormElement>(BUY_FORM)!;
    beforeRemount.dataset.mountProbe = "first-mount";
    mocks.getPublicListingBySlug.mockResolvedValue(
      publicListing({
        price_amount: "40.00",
        seller_display_name: "Card Vault Prime",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    await act(async () => FakeEventSource.instances.at(-1)!.emit("sync.required", SYNC_REQUIRED));
    await waitFor(() => expect(within(page.container).getAllByText(/Card Vault Prime/).length).toBeGreaterThan(0));
    const afterRemount = page.container.querySelector<HTMLFormElement>(BUY_FORM)!;
    expect(beforeRemount.isConnected).toBe(false);
    expect(afterRemount.dataset.mountProbe).toBeUndefined();
    expect(currentLoaderKey(page)).not.toBe(pageViewKey);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    await act(async () => dispatchPersistedPageShow());
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    await act(async () => page.router.navigate(`${LISTING_PATH}?reported=1`));
    await act(async () => page.router.navigate(-1));
    await waitFor(() => expect(page.router.state.location.search).toBe(""));
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    page = await show(served);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);
  });

  it("AC3 gives a new key for a second server render, another listing and a router back from another route", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "public-listing")!;

    const second = await open();
    expect(loaderEntryKey(second, "public-listing")).not.toBe(pageViewKey);
    expectBuyPostForwards(
      unhydratedFormSubmission(second.html, { form: BUY_FORM, submitter: 'button[type="submit"]' }),
      loaderEntryKey(second, "public-listing")!,
    );

    const page = await show(served);
    await act(async () => page.router.navigate("/other"));
    await act(async () => page.router.navigate(-1));
    await waitFor(() => expect(page.container.querySelector(BUY_FORM)).not.toBeNull());
    const backKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(backKey).not.toBe(pageViewKey);
    expect(backKey).toBe(currentLoaderKey(page));

    mocks.getPublicListingBySlug.mockResolvedValue(
      publicListing({ listing_id: "lst_2", listing_slug: "blastoise-lst_2", item_title: "Blastoise" }),
    );
    await act(async () => page.router.navigate("/listings/blastoise-lst_2"));
    await waitFor(() =>
      expect(within(page.container).getByRole("heading", { level: 1, name: "Blastoise" })).toBeTruthy(),
    );
    const otherListingKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(otherListingKey).toBe(currentLoaderKey(page));
    expect([pageViewKey, backKey]).not.toContain(otherListingKey);
  });
});

function publicListing(overrides: Partial<DiscoveryPublicListing> = {}): DiscoveryPublicListing {
  return {
    listing_id: "lst_1",
    listing_slug: "charizard-lst_1",
    product_slug: "charizard-prd_1",
    account_id: "acc_1",
    seller_slug: "card-vault-acc_1",
    seller_display_name: "Card Vault",
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    seller_average_rating: "4.9",
    seller_review_count: 12,
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cit_1",
    catalog_item_slug: "charizard-cit_1",
    product_id: "prd_1",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    product_summary: "Near Mint",
    storage_location_name: null,
    ship_from_code: "US",
    price_amount: "42.00",
    price_currency_code: "EUR",
    listing_stream_version: 3,
    shipping_allowance_percentage_bps: 500,
    quantity_cap: 1,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    status: "active",
    google_shopping_structured_data_payload: null,
    visible_quantity: 1,
    created_at: "2026-06-04T00:00:00.000Z",
    updated_at: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}
