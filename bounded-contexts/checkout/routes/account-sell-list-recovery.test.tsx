// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF } from "../support/request-support/account-sell-list-handoffs";
import { usePendingFreshWriteRevalidation } from "../support/route-support/pending-fresh-write-revalidation";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  MockCheckoutApiError,
  mockCreateCheckoutRequestApiClient,
  mockGetSellListCompositeReview,
  mockResolveActorFromAuthApi,
} from "../tests/support/checkout-route-test-harness";

vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: mockResolveActorFromAuthApi }));
vi.mock("../support/request-support/api-client", () => ({
  CheckoutApiError: MockCheckoutApiError,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

import SellListRoute, { loader } from "./account-sell-list";
import DeskOffersRoute, { loader as deskLoader } from "./account-desk-offers";
import CartRoute, { loader as cartLoader } from "./account-cart";

const line = {
  seller_account_id: "acc_seller",
  line_id: "sll_product",
  line_type: "product" as const,
  offer_id: null,
  listing_id: null,
  buyer_account_id: null,
  buyer_display_name: null,
  offer_price_amount: null,
  catalog_catalog_item_id: "cat_charizard",
  product_id: "prod_charizard",
  item_title: "Charizard",
  item_subtitle: "Base Set",
  selected_options: [],
  product_summary: "Near Mint",
  quantity: 1,
  fallback_mode: "create-listing" as const,
  minimum_listing_price_amount: "399.00",
  created_at: "2026-10-07T00:00:00.000Z",
  updated_at: "2026-10-07T00:00:00.000Z",
};
const review = { offerReviews: [], productOfferReviews: [], inventoryItems: [] };
const lag = () => new MockCheckoutApiError(503, { error: { code: "projection_freshness_timeout" } });
let router: ReturnType<typeof createMemoryRouter>;

async function settleRouter() {
  if (router.state.initialized && router.state.navigation.state === "idle") return;
  await new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
}

async function mount(path: string, options: { desk?: boolean; cart?: boolean } = {}) {
  router = createMemoryRouter(
    [
      {
        id: "sell-list",
        path: options.cart ? "/account/cart" : options.desk ? "/account/desk/offers" : "/account/sell-list",
        loader: options.cart ? cartLoader : options.desk ? deskLoader : loader,
        Component: options.cart ? CartRoute : options.desk ? DeskOffersRoute : SellListRoute,
        errorElement: <p>Route failed</p>,
      },
      { path: "/elsewhere", element: <p>Elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  await act(settleRouter);
  render(<RouterProvider router={router} />);
}

async function tick(ms = 2_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await settleRouter();
  });
}

describe("Sell List bounded receipt recovery through the data router", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    applyCheckoutRouteMockDefaults();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_seller", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList: vi.fn().mockResolvedValue({ items: [line], count: 1 }),
      getSellListCompositeReview: mockGetSellListCompositeReview,
      getSellListPayoutReadiness: vi.fn().mockResolvedValue({ status: "ready", missing_requirements: [] }),
    });
    mockGetSellListCompositeReview.mockResolvedValue(review);
  });

  afterEach(() => {
    cleanup();
    router?.dispose();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it.each([false, true])(
    "recovers compact-receipt Sell List review after a transient composite timeout (Desk reuse: %s)",
    async (desk) => {
      const path = await navigateAfterWriteWithPlatformPostWriteToken(
        checkoutCommit("13", "evt_sell_list_line"),
        desk ? "/account/desk/offers" : "/account/sell-list",
      );
      expect(path).toContain("postWriteToken=");
      expect(path).not.toContain("afterWrite=");
      let finishReview!: (value: typeof review) => void;
      mockGetSellListCompositeReview
        .mockRejectedValueOnce(lag())
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishReview = resolve;
            }),
        )
        .mockResolvedValue(review);
      await mount(path, { desk });
      expect(router.state.loaderData["sell-list"].sellList.items).toHaveLength(1);
      expect(screen.queryByRole("heading", { name: "Review items", exact: true })).toBeNull();
      expect(screen.getByRole("button", { name: "Continue to seller checkout" }).hasAttribute("disabled")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
      expect(router.state.navigation.state).toBe("loading");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("heading", { name: "Review items", exact: true })).toBeNull();
      await act(async () => {
        finishReview(review);
        await settleRouter();
      });
      expect(screen.getByRole("heading", { name: "Review items", exact: true })).toBeTruthy();
      expect(router.state.loaderData["sell-list"].sellListRecovery).toBeNull();
      expect(router.state.loaderData["sell-list"].pendingFreshWriteTiming).toEqual({
        observedAtMs: Date.now() - 6_000,
        expiresAtMs: Date.now() + 24_000,
      });
      expect(router.state.location.search).toBe(new URL(path, "http://localhost").search);
      await tick(30_000);
      expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves legacy Sell List recovery through a second loader call", async () => {
    mockGetSellListCompositeReview.mockRejectedValueOnce(lag());
    await mount(appendFreshWriteToken("/account/sell-list", checkoutCommit("13", "evt_sell_list_line")));
    expect(screen.queryByRole("heading", { name: "Review items", exact: true })).toBeNull();
    await tick();
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Review items", exact: true })).toBeTruthy();
  });

  it.each(["missing", "malformed", "unresolved", "expired", "future"])(
    "does not authorize automatic recovery from a %s receipt",
    async (kind) => {
      mockGetSellListCompositeReview.mockRejectedValue(lag());
      const path =
        kind === "missing"
          ? "/account/sell-list"
          : kind === "malformed"
            ? "/account/sell-list?afterWrite=not-a-receipt"
            : kind === "unresolved"
              ? "/account/sell-list?postWriteToken=pwt_test9999999999999999"
              : await navigateAfterWriteWithPlatformPostWriteToken(
                  checkoutCommit("13", "evt_sell_list_line"),
                  "/account/sell-list",
                  { nowMs: Date.now() + (kind === "future" ? 6_000 : -30_001) },
                );
      await mount(path);
      expect(screen.getByText("Route failed")).toBeTruthy();
      const calls = mockGetSellListCompositeReview.mock.calls.length;
      await tick(40_000);
      expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(calls);
      expect(screen.queryByRole("heading", { name: "Review items", exact: true })).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "internal_error"],
    [503, "unavailable"],
  ])("does not conceal permanent composite failures (%s/%s)", async (status, code) => {
    const path =
      status === 404
        ? "/account/sell-list"
        : await navigateAfterWriteWithPlatformPostWriteToken(
            checkoutCommit("13", "evt_sell_list_line"),
            "/account/sell-list",
          );
    mockGetSellListCompositeReview.mockRejectedValue(new MockCheckoutApiError(Number(status), { error: { code } }));
    await mount(path);
    expect(screen.getByText("Route failed")).toBeTruthy();
    await tick(40_000);
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains bounded recovery for transient 404 with a validated receipt", async () => {
    mockGetSellListCompositeReview.mockRejectedValueOnce(
      new MockCheckoutApiError(404, { error: { code: "not_found" } }),
    );
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
    );
    await mount(path);
    expect(screen.getByText("Your Sell List is catching up")).toBeTruthy();
    await tick();
    expect(screen.getByRole("heading", { name: "Review items", exact: true })).toBeTruthy();
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
  });

  it("does not renew the same compact receipt or attempt budget on loader revalidation", async () => {
    const observedAtMs = Date.now();
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
    );
    mockGetSellListCompositeReview.mockRejectedValue(lag());
    await mount(path);
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      await tick();
      expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(attempt + 1);
      expect(router.state.loaderData["sell-list"].pendingFreshWriteTiming).toEqual({
        observedAtMs,
        expiresAtMs: observedAtMs + 30_000,
      });
    }
    await tick(10_000);
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(16);
    expect(screen.getByText("Refreshing Sell List")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Refresh Sell List" }).getAttribute("href")).toBe(path);
    expect(screen.queryByRole("heading", { name: "Review items", exact: true })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops persistent handoff lag at the original expiry and retains actionable recovery", async () => {
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
      { handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF, nowMs: Date.now() - 27_000 },
    );
    const getSellList = vi.fn().mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getSellList,
      getSellListCompositeReview: mockGetSellListCompositeReview,
    });
    await mount(path);
    expect(screen.getByText("Your Sell List is catching up")).toBeTruthy();
    await tick();
    expect(getSellList).toHaveBeenCalledTimes(2);
    await tick();
    expect(getSellList).toHaveBeenCalledTimes(3);
    expect(router.state.loaderData["sell-list"].sellListRecovery.kind).toBe("missing-after-fresh-write");
    expect(screen.getByRole("link", { name: "Refresh Sell List" }).getAttribute("href")).toBe("/account/sell-list");
    await tick(40_000);
    expect(getSellList).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["route change", "unmount"])("cancels pending work on %s", async (transition) => {
    mockGetSellListCompositeReview.mockRejectedValue(lag());
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
    );
    await mount(path);
    if (transition === "route change")
      await act(async () => {
        await router.navigate("/elsewhere");
      });
    else cleanup();
    await tick(40_000);
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ready", "empty"])("keeps %s routes inert on later loader calls", async (state) => {
    if (state === "empty")
      mockCreateCheckoutRequestApiClient.mockReturnValue({
        getSellList: vi.fn().mockResolvedValue({ items: [], count: 0 }),
        getSellListCompositeReview: mockGetSellListCompositeReview,
      });
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
    );
    await mount(path);
    await act(async () => {
      await router.navigate(path);
    });
    await tick(40_000);
    expect(mockGetSellListCompositeReview).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes only validated timing, never receipt sources or an expanded URL", async () => {
    const path = await navigateAfterWriteWithPlatformPostWriteToken(
      checkoutCommit("13", "evt_sell_list_line"),
      "/account/sell-list",
    );
    mockGetSellListCompositeReview.mockRejectedValueOnce(lag());
    await mount(path);
    const data = router.state.loaderData["sell-list"];
    expect(data.pendingFreshWriteTiming).toEqual({ observedAtMs: Date.now(), expiresAtMs: Date.now() + 30_000 });
    const serialized = JSON.stringify(data);
    for (const privateField of ["evt_sell_list_line", "maxGlobalPosition", "commitPosition", "afterWrite="]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it.each(["legacy", "compact"])("preserves the unchanged Cart caller's %s behavior", async (receipt) => {
    const getCart = vi.fn().mockRejectedValueOnce(lag()).mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ getCart });
    const path =
      receipt === "legacy"
        ? appendFreshWriteToken("/account/cart", checkoutCommit("13", "evt_cart_line"))
        : await navigateAfterWriteWithPlatformPostWriteToken(checkoutCommit("13", "evt_cart_line"), "/account/cart");
    await mount(path, { cart: true });
    expect(router.state.loaderData["sell-list"].cartRecovery.kind).toBe("pending-fresh-write");
    await tick();
    expect(getCart).toHaveBeenCalledTimes(receipt === "legacy" ? 2 : 1);
    if (receipt === "legacy") expect(router.state.loaderData["sell-list"].cartRecovery).toBeNull();
    await tick(40_000);
    expect(getCart).toHaveBeenCalledTimes(receipt === "legacy" ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers the single final expired-receipt navigation until the router is idle", async () => {
    const observedAtMs = Date.now() - 27_000;
    function PendingProbe() {
      const { isAutoRevalidating } = usePendingFreshWriteRevalidation(true, {
        freshWrite: { observedAtMs, expiresAtMs: observedAtMs + 30_000 },
      });
      return <output>{isAutoRevalidating ? "auto" : "manual"}</output>;
    }
    let finishLoad!: () => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            finishLoad = () => resolve(null);
          }),
      )
      .mockResolvedValue(null);
    router = createMemoryRouter([{ path: "/account/sell-list", loader: load, Component: PendingProbe }], {
      initialEntries: ["/account/sell-list?postWriteToken=pwt_test9082000000000002"],
    });
    await act(settleRouter);
    render(<RouterProvider router={router} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(router.state.navigation.state).toBe("loading");
    await act(async () => {
      finishLoad();
      await settleRouter();
    });
    await tick();
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText("manual")).toBeTruthy();
    await tick(40_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
