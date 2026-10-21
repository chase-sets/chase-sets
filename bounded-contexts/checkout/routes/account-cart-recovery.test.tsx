// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import {
  applyCheckoutRouteMockDefaults,
  checkoutCommit,
  MockCheckoutApiError,
  mockCreateCheckoutRequestApiClient,
  mockGetCart,
  mockGetCartCommandAttempt,
  mockGetGuestCart,
  mockResolveActorFromAuthApi,
  mockSubmitCartCommands,
  mockSubmitGuestCartCommands,
} from "../tests/support/checkout-route-test-harness";
import { cartAttemptResult, committedCartAttempt } from "../tests/support/cart-attempt-results";

vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: mockResolveActorFromAuthApi }));
vi.mock("../support/request-support/api-client", () => ({
  CheckoutApiError: MockCheckoutApiError,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

import CartRoute, { action, loader } from "./account-cart";

const line = {
  line_id: "cart_line_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_language_code: "en",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  item_image_url: null,
  item_image_srcset: null,
  item_image_loading_url: null,
  item_image_loading_alt: null,
  item_image_loading_srcset: null,
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Form: Raw | Condition: Near Mint",
  quantity: 2,
  fulfillment_mode: "optimize",
  locked_listing_id: null,
  selected_listing_id: null,
  selected_listing_seller_account_id: null,
  selected_listing_seller_display_name: null,
  selected_listing_seller_slug: null,
  selected_listing_price_amount: null,
  selected_listing_price_currency_code: null,
  selected_listing_stream_version: null,
  selected_listing_snapshot_source: null,
  selected_listing_snapshot_captured_at: null,
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [],
  created_at: "2026-10-19T00:00:00.000Z",
  updated_at: "2026-10-19T00:00:00.000Z",
};

let router: ReturnType<typeof createMemoryRouter>;

async function settleRouter() {
  if (router.state.initialized && router.state.navigation.state === "idle" && idleFetchers()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle" && idleFetchers()) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function idleFetchers() {
  return [...router.state.fetchers.values()].every((fetcher) => fetcher.state === "idle");
}

async function mount() {
  router = createMemoryRouter(
    [{ id: "cart", path: "/account/cart", loader, action, Component: CartRoute, errorElement: <p>Route failed</p> }],
    { initialEntries: ["/account/cart"] },
  );
  await act(settleRouter);
  render(<RouterProvider router={router} />);
}

/** A native or Base UI control refuses interaction by any of its disabled markers. */
function isDisabled(element: HTMLElement) {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled")
  );
}

function sentAttemptIds() {
  return mockSubmitCartCommands.mock.calls.map(([body]) => (body as { attemptId: string }).attemptId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("account cart attempt recovery through the data router", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: ["checkout.manage"] });
    mockGetCart.mockResolvedValue({ items: [line], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getCart: mockGetCart,
      getGuestCart: mockGetGuestCart,
      submitCartCommands: mockSubmitCartCommands,
      submitGuestCartCommands: mockSubmitGuestCartCommands,
      getCartCommandAttempt: mockGetCartCommandAttempt,
    });
  });

  afterEach(() => {
    cleanup();
    router?.dispose();
    vi.resetAllMocks();
  });

  it("holds a lost submission as ambiguous after one lookup, focuses and announces it, and resends only on request with the same attempt id", async () => {
    const user = userEvent.setup();
    mockSubmitCartCommands.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({
      status: "completed",
      attempt: committedCartAttempt([{ command: "remove", lineId: "cart_line_1" }]),
      ...checkoutCommit("81", "evt_cart_line_removed"),
    });
    mockGetCartCommandAttempt.mockResolvedValue(cartAttemptResult("not-observed"));
    await mount();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    const heading = await screen.findByRole("heading", {
      name: t("checkout.features.cart.ui.cartPage.attempt.ambiguous.title"),
    });
    await act(settleRouter);
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockGetCartCommandAttempt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      screen.getByText(t("checkout.features.cart.ui.cartPage.attempt.ambiguous.description")).closest("[aria-live]"),
    ).not.toBeNull();
    // The lost change is not re-applied optimistically and no new change can start.
    expect(screen.getAllByText("Charizard").length).toBeGreaterThan(0);
    expect(isDisabled(screen.getByRole("button", { name: "Remove" }))).toBe(true);
    expect(isDisabled(screen.getByRole("button", { name: "Increase" }))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await act(settleRouter);
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);

    mockGetCart.mockResolvedValue({ items: [], count: 0 });
    await user.click(screen.getByRole("button", { name: t("checkout.features.cart.ui.cartPage.attempt.resend") }));
    await act(settleRouter);

    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(2);
    const [first, resent] = sentAttemptIds();
    expect(resent).toBe(first);
    expect(mockSubmitCartCommands.mock.calls[1]?.[0]).toEqual(mockSubmitCartCommands.mock.calls[0]?.[0]);
    expect(mockGetCartCommandAttempt).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: t("checkout.features.cart.ui.cartPage.attempt.ambiguous.title") }),
      ).toBeNull(),
    );
  });

  it("lists the terminal lines of a partial attempt and leaves the cart editable", async () => {
    const user = userEvent.setup();
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([
        { command: "quantity", lineId: "cart_line_1" },
        { command: "remove", lineId: "cart_line_gone", outcome: "conflict", message: "Cart line not found." },
      ]),
      ...checkoutCommit("82", "evt_partial"),
    });
    await mount();

    await user.click(screen.getByRole("button", { name: "Increase" }));

    expect(
      await screen.findByRole("heading", { name: t("checkout.features.cart.ui.cartPage.attempt.partial.title") }),
    ).toBeTruthy();
    expect(screen.getByText("Cart line not found.")).toBeTruthy();
    await act(settleRouter);
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
    expect(isDisabled(screen.getByRole("button", { name: "Remove" }))).toBe(false);
  });

  it("renders a committed change whose read still lags as confirming, without a lookup or a resend", async () => {
    const user = userEvent.setup();
    mockSubmitCartCommands.mockResolvedValue({
      status: "completed",
      attempt: committedCartAttempt([{ command: "remove", lineId: "cart_line_1" }]),
      ...checkoutCommit("85", "evt_cart_line_removed"),
    });
    await mount();
    mockGetCart.mockRejectedValueOnce(
      new MockCheckoutApiError(503, { error: { code: "projection_freshness_timeout" } }),
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await act(settleRouter);

    expect(router.state.location.search).toContain("postWriteToken=");
    expect(router.state.loaderData.cart.cartRecovery.kind).toBe("pending-fresh-write");
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: t("checkout.features.cart.ui.cartPage.attempt.ambiguous.title") }),
    ).toBeNull();
  });

  it("refuses a change without a cart owner before anything is sent", async () => {
    const user = userEvent.setup();
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [line], count: 1 });
    await mount();

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByRole("heading", { name: t("checkout.features.cart.ui.cartPage.attempt.failed.safe.title") }),
    ).toBeTruthy();
    expect(mockSubmitCartCommands).not.toHaveBeenCalled();
    expect(mockSubmitGuestCartCommands).not.toHaveBeenCalled();
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
  });

  it("sends a change queued behind an in-flight one as its own attempt, and two deliberate identical changes never share an id", async () => {
    const user = userEvent.setup();
    const firstWrite = deferred<unknown>();
    mockSubmitCartCommands
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue({
        status: "completed",
        attempt: committedCartAttempt([{ command: "quantity", lineId: "cart_line_1" }]),
        ...checkoutCommit("84", "evt_quantity_second"),
      });
    await mount();

    await user.click(screen.getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1));
    // A second deliberate change while the first is in flight waits in the queue.
    await user.click(screen.getByRole("button", { name: "Increase" }));
    expect(mockSubmitCartCommands).toHaveBeenCalledTimes(1);

    mockGetCart.mockResolvedValue({ items: [{ ...line, quantity: 3 }], count: 1 });
    firstWrite.resolve({
      status: "completed",
      attempt: committedCartAttempt([{ command: "quantity", lineId: "cart_line_1" }]),
      ...checkoutCommit("83", "evt_quantity_first"),
    });
    await waitFor(() => expect(mockSubmitCartCommands).toHaveBeenCalledTimes(2));
    await act(settleRouter);

    const [firstId, secondId] = sentAttemptIds();
    expect(firstId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(secondId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(secondId).not.toBe(firstId);
    expect(mockSubmitCartCommands.mock.calls.map(([body]) => (body as { commands: unknown }).commands)).toEqual([
      [{ type: "quantity", lineId: "cart_line_1", quantity: 3 }],
      [{ type: "quantity", lineId: "cart_line_1", quantity: 4 }],
    ]);
    expect(mockGetCartCommandAttempt).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: t("checkout.features.cart.ui.cartPage.attempt.partial.title") }),
    ).toBeNull();
  });
});
