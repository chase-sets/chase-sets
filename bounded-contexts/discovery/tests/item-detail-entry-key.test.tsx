// @vitest-environment jsdom
import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteObject } from "react-router";

import type { DiscoveryItemDetail, DiscoveryMarketListing } from "../support/client-support/contracts";
import {
  captureNativeSubmissions,
  createCheckoutEntryStub,
  dispatchPersistedPageShow,
  expectDocument,
  expectRedirect,
  FakeEventSource,
  hiddenEntryKey,
  hydrateDocument,
  loaderEntryKey,
  postForm,
  serverRender,
  SYNC_REQUIRED,
  type HydratedDocument,
  type ServerDocument,
} from "./entry-attempt-key-harness";

type CheckoutEntryStub = ReturnType<typeof createCheckoutEntryStub>;

const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  getItemDetail: vi.fn(),
  checkout: { current: null as CheckoutEntryStub | null },
}));

vi.mock("@chase-sets/platform-runtime/auth", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>("@chase-sets/platform-runtime/auth")),
  resolveActorFromAuthApi: mocks.resolveActor,
  requireActorFromAuthApi: mocks.resolveActor,
}));

vi.mock("../support/request-support/api-client", () => ({
  DiscoveryApiError: class DiscoveryApiError extends Error {},
  createDiscoveryRequestApiClient: () => ({
    getItemDetail: mocks.getItemDetail,
    getSimilarItems: async () => ({ items: [] }),
  }),
}));

vi.mock("@chase-sets/marketplace/server", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/marketplace/server")>("@chase-sets/marketplace/server")),
  createMarketplaceRequestApiClient: () => ({}),
}));

vi.mock("@chase-sets/inventory/server", () => ({ createInventoryRequestApiClient: () => ({}) }));

// The real attempt-id helpers stay; only the Checkout transport is the #9994 stub.
vi.mock("@chase-sets/checkout/server", async () => ({
  ...(await vi.importActual<typeof import("@chase-sets/checkout/server")>("@chase-sets/checkout/server")),
  createCheckoutRequestApiClient: () => ({
    createCheckoutSession: (request: Parameters<CheckoutEntryStub["createCheckoutSession"]>[0]) =>
      mocks.checkout.current!.createCheckoutSession(request),
  }),
}));

import DiscoveryItemDetailRoute, { action, loader } from "../routes/item-detail";
import { alternateListing, baseListing, createItem, variantSchema } from "./item-detail-commerce-panel-test-harness";

const ITEM_PATH = "/items/charizard-base-set-cat_charizard";
const BUY_FORM = "form#buy-card-buy-now";
const routes: RouteObject[] = [
  { id: "item-detail", path: "/items/:id", loader, action, Component: DiscoveryItemDetailRoute },
  { id: "other", path: "/other", Component: () => <p>Another page</p> },
];
const signedInBuyer = { accountId: "acc_buyer", userId: "usr_buyer", permissions: [] };

const pricierListing: DiscoveryMarketListing = {
  ...alternateListing,
  listing_id: "listing_charizard_pricier",
  account_id: "seller_3",
  seller_display_name: "Top Shelf",
  price_amount: "450.00",
};

let mounted: HydratedDocument | null = null;
let checkout: CheckoutEntryStub;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  checkout = createCheckoutEntryStub();
  mocks.checkout.current = checkout;
  mocks.resolveActor.mockResolvedValue(signedInBuyer);
  mocks.getItemDetail.mockResolvedValue(item());
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function item(overrides: Partial<DiscoveryItemDetail> = {}) {
  return createItem({ market_listings: [baseListing, alternateListing], offer_demand_matches: [], ...overrides });
}

async function open(path = ITEM_PATH) {
  return expectDocument(await serverRender(routes, new Request(`http://localhost${path}`)));
}

/** The browser's document POST: the action answers with a redirect or a new document. */
async function postDocument(body: URLSearchParams, path = ITEM_PATH) {
  return serverRender(routes, postForm(`http://localhost${path}`, body));
}

async function show(served: ServerDocument) {
  mounted?.unmount();
  mounted = await hydrateDocument(served, routes);
  return mounted;
}

function buyButton(page: HydratedDocument) {
  return within(page.container.querySelector<HTMLFormElement>(BUY_FORM)!).getByRole("button", { name: /^Buy / });
}

async function clickBuy(page: HydratedDocument, clicks = 1) {
  const submissions = captureNativeSubmissions();
  const user = userEvent.setup();
  for (let click = 0; click < clicks; click += 1) {
    await user.click(buyButton(page));
  }
  submissions.stop();
  expect(submissions.bodies).toHaveLength(clicks);
  return submissions.bodies;
}

async function realtimeSource() {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  return FakeEventSource.instances.at(-1)!;
}

describe("item detail Buy now entry key", () => {
  it("AC1 sends one key on double submit, POST resubmit and a re-click after a returned error, so Checkout returns the first Session", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail");
    expect(pageViewKey).toMatch(/^chkentry_[0-9A-Z]{26}$/);

    const page = await show(served);
    const [first, second] = await clickBuy(page, 2);
    expect(first!.get("entryAttemptKey")).toBe(pageViewKey);
    expect(second!.get("entryAttemptKey")).toBe(pageViewKey);

    for (const body of [first!, second!, first!]) {
      expect(expectRedirect(await postDocument(body)).location.pathname).toBe("/checkout/buy/session/chk_session_1");
    }
    expect(checkout.sessionCount()).toBe(1);

    // A fresh page view whose first Buy now opens a Session that never answers.
    const fresh = await open();
    const freshKey = loaderEntryKey(fresh, "item-detail");
    const freshPage = await show(fresh);
    checkout.loseNextResponse();
    const [lost] = await clickBuy(freshPage);
    const errorPage = await show(expectDocument(await postDocument(lost!)));
    expect(within(errorPage.container).getAllByText("Checkout did not answer. Try again.").length).toBeGreaterThan(0);
    expect(hiddenEntryKey(errorPage.container, BUY_FORM)).toBe(freshKey);

    const [reclick] = await clickBuy(errorPage);
    expect(reclick!.get("entryAttemptKey")).toBe(freshKey);
    expect(expectRedirect(await postDocument(reclick!)).location.pathname).toBe("/checkout/buy/session/chk_session_2");
    expect(checkout.sessionCount()).toBe(2);
    expect(checkout.sentKeys).toEqual([pageViewKey, pageViewKey, pageViewKey, freshKey, freshKey]);
  });

  it("AC2 gives the form a second key when quantity changes, keeps it for that submission's retries and across a display-only patch", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail");
    const page = await show(served);
    const user = userEvent.setup();

    const quantity = within(page.container.querySelector<HTMLFormElement>(BUY_FORM)!).getByRole("spinbutton", {
      name: "Quantity",
    });
    await user.tripleClick(quantity);
    await user.keyboard("2");
    const changedKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(changedKey).not.toBe(pageViewKey);
    expect(changedKey).toMatch(/^chkentry_[0-9A-Z]{26}$/);

    const source = await realtimeSource();
    await act(async () => {
      source.emit("projection.patch", {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["discovery.item.cat_charizard"],
        changes: [
          {
            op: "upsert",
            entity: "discovery.marketListing",
            id: baseListing.listing_id,
            value: { ...baseListing, seller_display_name: "Chase Sets Vault", price_amount: "389.99" },
          },
        ],
      });
    });
    await waitFor(() => expect(within(page.container).getAllByText(/389\.99/).length).toBeGreaterThan(0));
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(changedKey);

    const [first, retry] = await clickBuy(page, 2);
    expect(first!.get("quantity")).toBe("2");
    expect([first!.get("entryAttemptKey"), retry!.get("entryAttemptKey")]).toEqual([changedKey, changedKey]);
    for (const body of [first!, retry!, first!]) {
      expect(expectRedirect(await postDocument(body)).location.pathname).toBe("/checkout/buy/session/chk_session_1");
    }
    expect(checkout.sessionCount()).toBe(1);
  });

  it("AC2 gives the form a second key when the listing or the product options change", async () => {
    const graded: DiscoveryMarketListing = {
      ...pricierListing,
      product_id: "cat_charizard::form:graded",
      selected_options: [{ dimensionId: "form", optionId: "graded" }],
      product_summary: "Graded",
    };
    mocks.getItemDetail.mockResolvedValue(
      item({
        product_schema: variantSchema,
        market_listings: [
          {
            ...baseListing,
            product_id: "cat_charizard::form:raw",
            selected_options: [{ dimensionId: "form", optionId: "raw" }],
          },
          {
            ...alternateListing,
            product_id: "cat_charizard::form:raw",
            selected_options: [{ dimensionId: "form", optionId: "raw" }],
          },
          graded,
        ],
      }),
    );
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail");
    const page = await show(served);
    const user = userEvent.setup();

    await user.click(within(page.container).getByRole("button", { name: "Select Card Vault listing at $410.00" }));
    const listingKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(listingKey).not.toBe(pageViewKey);
    const [listingBody] = await clickBuy(page);
    expect(listingBody!.get("lockedListingId")).toBe(alternateListing.listing_id);
    expect(listingBody!.get("entryAttemptKey")).toBe(listingKey);

    const formOptions = within(page.container).getAllByRole("radiogroup", { name: "Form" })[0]!;
    await user.click(within(formOptions).getByRole("radio", { name: /^Graded/ }));
    await waitFor(() => expect(hiddenEntryKey(page.container, BUY_FORM)).not.toBe(listingKey));
    const optionsKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(optionsKey).not.toBe(pageViewKey);
    const [optionsBody] = await clickBuy(page);
    expect(optionsBody!.get("productId")).toBe("cat_charizard::form:graded");
    expect(optionsBody!.get("entryAttemptKey")).toBe(optionsKey);
  });

  it("AC3 keeps the key across a realtime revalidation remount, a persisted pageshow, re-hydration and a router back across a same-page search", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail")!;
    let page = await show(served);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    // A listing joins and display fields change: the realtime view is keyed by the listing set, so it remounts.
    const beforeRemount = page.container.querySelector<HTMLFormElement>(BUY_FORM)!;
    beforeRemount.dataset.mountProbe = "first-mount";
    mocks.getItemDetail.mockResolvedValue(
      item({
        subtitle: "Base Set 4/102 Holo Rare (Unlimited)",
        market_listings: [baseListing, alternateListing, pricierListing],
      }),
    );
    const source = await realtimeSource();
    await act(async () => source.emit("sync.required", SYNC_REQUIRED));
    await waitFor(() => expect(within(page.container).getByText("Top Shelf")).toBeTruthy());
    const afterRemount = page.container.querySelector<HTMLFormElement>(BUY_FORM)!;
    expect(beforeRemount.isConnected).toBe(false);
    expect(afterRemount.dataset.mountProbe).toBeUndefined();
    expect(currentLoaderKey(page)).not.toBe(pageViewKey);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    await act(async () => dispatchPersistedPageShow());
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    await act(async () => page.router.navigate(`${ITEM_PATH}?market=watch`));
    await act(async () => page.router.navigate(-1));
    await waitFor(() => expect(page.router.state.location.search).toBe(""));
    expect(page.router.state.navigation.state).toBe("idle");
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);

    page = await show(served);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(pageViewKey);
  });

  it("AC3 gives a new key for a second server render, another item and a router back from another route", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail")!;

    const second = await open();
    expect(loaderEntryKey(second, "item-detail")).not.toBe(pageViewKey);
    expect(unhydratedKey(second)).toBe(loaderEntryKey(second, "item-detail"));

    const page = await show(served);
    await act(async () => page.router.navigate("/other"));
    await act(async () => page.router.navigate(-1));
    await waitFor(() => expect(page.container.querySelector(BUY_FORM)).not.toBeNull());
    const backKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(backKey).not.toBe(pageViewKey);
    expect(backKey).toBe(currentLoaderKey(page));

    mocks.getItemDetail.mockResolvedValue(
      createItem({
        catalog_item_id: "cat_blastoise",
        slug: "blastoise-base-set-cat_blastoise",
        title: "Blastoise",
        market_listings: [
          {
            ...baseListing,
            listing_id: "listing_blastoise",
            catalog_catalog_item_id: "cat_blastoise",
            product_id: "cat_blastoise::",
          },
        ],
        offer_demand_matches: [],
      }),
    );
    await act(async () => page.router.navigate("/items/blastoise-base-set-cat_blastoise"));
    await waitFor(() => expect(within(page.container).getAllByText("Blastoise").length).toBeGreaterThan(0));
    const otherItemKey = hiddenEntryKey(page.container, BUY_FORM);
    expect(otherItemKey).toBe(currentLoaderKey(page));
    expect([pageViewKey, backKey]).not.toContain(otherItemKey);
  });

  it("AC5 shows the changed copy after a 409, resends nothing, and the next submit sends the fresh key to one new Session", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail")!;
    const page = await show(served);
    const [first] = await clickBuy(page);
    expect(expectRedirect(await postDocument(first!)).location.pathname).toBe("/checkout/buy/session/chk_session_1");

    // History restores this document and the browser restores quantity 2 without an input event.
    const restoredQuantity = page.container.querySelector<HTMLInputElement>(`${BUY_FORM} input[name="quantity"]`)!;
    restoredQuantity.value = "2";
    const [stale] = await clickBuy(page);
    expect(stale!.get("entryAttemptKey")).toBe(pageViewKey);
    expect(stale!.get("quantity")).toBe("2");

    const changed = expectDocument(await postDocument(stale!));
    const freshKey = (changed.hydrationData.actionData?.["item-detail"] as { entryAttemptKey: string }).entryAttemptKey;
    expect(freshKey).toMatch(/^chkentry_[0-9A-Z]{26}$/);
    const changedPage = await show(changed);
    expect(
      within(changedPage.container).getAllByText(
        "Your selection changed after you chose Buy now. Check it and choose Buy now again.",
      ).length,
    ).toBeGreaterThan(0);
    expect(hiddenEntryKey(changedPage.container, BUY_FORM)).toBe(freshKey);
    expect([pageViewKey, loaderEntryKey(changed, "item-detail")]).not.toContain(freshKey);
    expect(checkout.sentKeys).toEqual([pageViewKey, pageViewKey]);

    const [next] = await clickBuy(changedPage);
    expect(next!.get("entryAttemptKey")).toBe(freshKey);
    expect(expectRedirect(await postDocument(next!)).location.pathname).toBe("/checkout/buy/session/chk_session_2");
    expect(checkout.sentKeys).toEqual([pageViewKey, pageViewKey, freshKey]);
    expect(checkout.sessionCount()).toBe(2);
  });

  it("AC5 adopts a later action-data key while the page stays mounted and ignores the revalidated loader key", async () => {
    const served = await open();
    const pageViewKey = loaderEntryKey(served, "item-detail")!;
    const page = await show(served);
    const [first] = await clickBuy(page);
    expect(expectRedirect(await postDocument(first!)).location.pathname).toBe("/checkout/buy/session/chk_session_1");

    const changedSubmission = new FormData();
    for (const [name, value] of first!) {
      changedSubmission.append(name, name === "quantity" ? "2" : value);
    }
    await act(async () => page.router.navigate(ITEM_PATH, { formMethod: "post", formData: changedSubmission }));
    await waitFor(() => expect(page.router.state.navigation.state).toBe("idle"));

    const freshKey = (page.router.state.actionData?.["item-detail"] as { entryAttemptKey: string }).entryAttemptKey;
    expect(freshKey).toMatch(/^chkentry_[0-9A-Z]{26}$/);
    expect([pageViewKey, currentLoaderKey(page)]).not.toContain(freshKey);
    expect(hiddenEntryKey(page.container, BUY_FORM)).toBe(freshKey);

    const [next] = await clickBuy(page);
    expect(next!.get("entryAttemptKey")).toBe(freshKey);
    expect(expectRedirect(await postDocument(next!)).location.pathname).toBe("/checkout/buy/session/chk_session_2");
    expect(checkout.sentKeys).toEqual([pageViewKey, pageViewKey, freshKey]);
  });
});

function currentLoaderKey(page: HydratedDocument) {
  return (page.router.state.loaderData["item-detail"] as { entryAttemptKey?: string } | undefined)?.entryAttemptKey;
}

function unhydratedKey(served: ServerDocument) {
  const container = document.createElement("div");
  container.innerHTML = served.html;
  return hiddenEntryKey(container, BUY_FORM);
}
