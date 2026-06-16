// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutCartPage } from "./cart-page";
import type { CheckoutCartLine } from "./contracts";

const { mockFetcherSubmit, mockUseFetcher } = vi.hoisted(() => ({
  mockFetcherSubmit: vi.fn(),
  mockUseFetcher: vi.fn(() => ({
    state: "idle",
    data: null as { error?: string } | null,
    submit: mockFetcherSubmit,
  })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useFetcher: mockUseFetcher,
  };
});

const cartLine: CheckoutCartLine = {
  buyer_account_id: "acc_buyer",
  line_id: "cart_line_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::condition:raw",
  item_language_code: "ja",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  item_image_url: "/fake-cdn/assets/charizard.png",
  item_image_srcset: "/fake-cdn/assets/charizard.png 1x, /fake-cdn/assets/charizard@2x.png 2x",
  item_image_loading_url: "/fake-cdn/assets/pokemon_tcg_back.png",
  item_image_loading_alt: "Pokemon card back",
  item_image_loading_srcset: "/fake-cdn/assets/pokemon_tcg_back.png 1x",
  selected_options: [{ dimensionId: "condition", optionId: "raw" }],
  product_summary: "Form: Raw | Condition: Near Mint",
  quantity: 2,
  fulfillment_mode: "optimize",
  locked_listing_id: null,
  seller_preference_id: null,
  availability_state: "available",
  seller_options: [
    {
      listing_id: "lst_card_vault",
      seller_account_id: "acc_card_vault",
      seller_slug: "card-vault",
      seller_display_name: "Card Vault",
      seller_average_rating: "4.90",
      seller_review_count: 12,
      price_amount: "389.00",
      available_quantity: 2,
      product_summary: "Form: Raw | Condition: Near Mint",
    },
    {
      listing_id: "lst_hobby_shop",
      seller_account_id: "acc_hobby_shop",
      seller_slug: "hobby-shop",
      seller_display_name: "Hobby Shop",
      seller_average_rating: null,
      seller_review_count: 0,
      price_amount: "395.00",
      available_quantity: 1,
      product_summary: "Form: Raw | Condition: Near Mint",
    },
  ],
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

function quantitySpinbutton() {
  return screen.getByRole("spinbutton", { name: "Quantity" }) as HTMLInputElement;
}

describe("checkout cart page", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: null,
      submit: mockFetcherSubmit,
    }));
  });

  it("renders a minimalist cart review with indicative pricing and a single deferred total", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(markup).toContain("Your cart");
    expect(markup).toContain("Review quantities and remove anything you do not want before checkout.");
    expect(markup).toContain("Charizard");
    expect(markup).toContain("Base Set 4/102 Holo Rare");
    expect(markup).toContain("Japanese");
    expect(markup).toContain(">Raw</span>");
    expect(markup).toContain(">Near Mint</span>");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Quantity");
    expect(markup).toContain("Decrease");
    expect(markup).toContain("Increase");
    expect(markup).toContain("Remove");
    // Indicative per-line price: an `optimize` line surfaces its known floor.
    expect(markup).toContain(">from</p>");
    expect(markup).toContain("$778.00");
    // Exactly one deferred total, stated once.
    expect(markup).toContain("Estimated total");
    expect(markup).toContain("Final total confirmed at checkout");
    expect(markup).toContain("Shipping and tax");
    expect(markup).toContain("Calculated at checkout");
    expect(markup).toContain("Check out");
    expect(markup).toContain('action="/checkout/buy/readiness"');
    expect(markup).toContain('name="readinessSnapshotId"');
    expect(markup).toContain('name="readinessSourceRevision"');
    expect(markup).toContain('name="readinessDecisions"');
    // The broken "Price at checkout" / duplicate-Subtotal pattern is eliminated.
    expect(markup).not.toContain("Price at checkout");
    expect(markup).not.toContain("Subtotal");
    expect(markup).not.toContain("Update");
    // Demoted, non-danger Remove (ghost DestructiveAction, not tone="danger").
    expect(markup).not.toContain("Smart Match settings");
    expect(markup).not.toContain("Seller option");
  });

  it("renders exactly one primary action on the checkout surface", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    const primaryStamps = markup.match(/data-primary-action-count="1"/g) ?? [];
    // The sticky CTA bar owns the single primary; per-line action stacks stamp 0.
    expect(primaryStamps.length).toBe(1);
    expect(markup).toContain('data-primary-action-count="0"');
  });

  it("uses the canonical quantity stepper instead of the old input + button cluster", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    // Base UI NumberField renders the editable value as a numeric spinbutton;
    // native spinner chevrons are suppressed globally in DS styles.
    expect(markup).toContain('role="spinbutton"');
    expect(markup).toContain('inputMode="numeric"');
    // The old manual quantity submit button is gone.
    expect(markup).not.toContain("Update");
  });

  it("groups duplicate product intent as one quantity-controlled cart line", () => {
    const duplicateLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_2",
      quantity: 3,
      updated_at: "2026-04-29T00:00:00.000Z",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine, duplicateLine]} />);

    expect(markup).toContain('src="/fake-cdn/assets/charizard.png"');
    expect(markup).toContain('name="lineId" value="cart_line_1"');
    expect(markup).toContain('name="lineId" value="cart_line_2"');
    expect(markup).toContain("$1,945.00");
    expect(markup).not.toContain("Catalog item:");
    expect(markup).not.toContain("cat_charizard");
  });

  it("updates quantity and estimated total optimistically before loader correction returns", async () => {
    const user = userEvent.setup();
    render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));

    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    expect(screen.getAllByText("$1,167.00").length).toBeGreaterThan(0);
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(1);

    const formData = mockFetcherSubmit.mock.calls[0]?.[0] as FormData;
    expect(formData.get("intent")).toBe("update-cart-line");
    expect(formData.get("quantity")).toBe("3");
    expect(formData.get("optimisticStrategy")).toBe("optimistic-with-correction");
    expect(formData.get("correctionSource")).toBe("fresh-read:loader-revalidation");
    expect(formData.get("optimisticSequence")).toBe("1");
    expect(formData.getAll("lineId")).toEqual(["cart_line_1"]);
  });

  it("coalesces rapid repeated quantity clicks for one line", async () => {
    const user = userEvent.setup();
    render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    await user.click(screen.getByRole("button", { name: "Increase" }));
    await user.click(screen.getByRole("button", { name: "Increase" }));

    await waitFor(() => expect(quantitySpinbutton().value).toBe("5"));
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("$1,945.00").length).toBeGreaterThan(0);
  });

  it("reconciles optimistic quantity and estimated total to server loader truth", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    expect(screen.getAllByText("$1,167.00").length).toBeGreaterThan(0);

    rerender(<CheckoutCartPage cartLines={[{ ...cartLine, quantity: 4 }]} />);

    await waitFor(() => expect(quantitySpinbutton().value).toBe("4"));
    expect(screen.getAllByText("$1,556.00").length).toBeGreaterThan(0);
  });

  it("keeps account cart quantity and estimated total optimistic when stale loader data returns first", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));

    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    expect(screen.getAllByText("$1,167.00").length).toBeGreaterThan(0);

    mockUseFetcher.mockImplementation(() => ({
      state: "loading",
      data: null,
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[{ ...cartLine, quantity: 1 }]} />);

    expect(quantitySpinbutton().value).toBe("3");
    expect(screen.getAllByText("$1,167.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("$389.00")).toBeNull();

    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: null,
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[{ ...cartLine, quantity: 3 }]} />);

    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    expect(screen.getAllByText("$1,167.00").length).toBeGreaterThan(0);
  });

  it("rolls back visible quantity and estimated total when the route rejects the write", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));

    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: { error: "Request failed." },
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[cartLine]} errorMessage="Request failed." />);

    await waitFor(() => expect(quantitySpinbutton().value).toBe("2"));
    expect(screen.getByText("Checkout issue")).toBeTruthy();
    expect(screen.getAllByText("$778.00").length).toBeGreaterThan(0);
  });

  it("submits grouped duplicate lines as one absolute optimistic target", async () => {
    const user = userEvent.setup();
    const duplicateLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_2",
      quantity: 3,
      updated_at: "2026-04-29T00:00:00.000Z",
    };

    render(<CheckoutCartPage cartLines={[cartLine, duplicateLine]} />);

    await user.click(screen.getByRole("button", { name: "Decrease" }));

    await waitFor(() => expect(quantitySpinbutton().value).toBe("4"));

    const formData = mockFetcherSubmit.mock.calls[0]?.[0] as FormData;
    expect(formData.get("quantity")).toBe("4");
    expect(formData.getAll("lineId")).toEqual(["cart_line_1", "cart_line_2"]);
  });

  it("shows preferred listing context and a cart-side lock action", () => {
    const preferredLine: CheckoutCartLine = {
      ...cartLine,
      seller_preference_id: "lst_card_vault",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[preferredLine]} />);

    expect(markup).toContain("Preferred listing");
    expect(markup).toContain(
      "Card Vault is the starting preference. Smart Match may choose another available listing.",
    );
    expect(markup).toContain("Lock this listing");
    expect(markup).toContain('value="lock-preferred-listing"');
    expect(markup).toContain('name="intent"');
    expect(markup).toContain('name="sellerPreferenceId" value="lst_card_vault"');
    expect(markup).not.toContain("Locked listing");
  });

  it("shows an exact price with no indicative prefix for a locked listing", () => {
    const lockedLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_hobby_shop",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[lockedLine]} />);

    // Locked listing → exact line price (2 × $395.00), no "from" prefix on it.
    expect(markup).toContain("$790.00");
    expect(markup).toContain("is locked for checkout unless availability changes.");
  });

  it("blocks checkout, defers the price, and hands unresolved fulfillment to readiness", () => {
    const unavailableLine: CheckoutCartLine = {
      ...cartLine,
      line_id: "cart_line_unavailable",
      product_id: "cat_charizard::condition:played",
      product_summary: "Form: Raw | Condition: Played",
      availability_state: "waiting-for-supply",
      seller_options: [],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[unavailableLine]} />);

    expect(markup).toContain("Some items need attention");
    expect(markup).toContain("1 item needs fulfillment or availability resolved before checkout.");
    expect(markup).toContain("Waiting for supply");
    expect(markup).toContain("Find alternatives");
    expect(markup).toContain('href="/search?q=Charizard"');
    expect(markup).toContain("Continue to checkout");
    // No priced options → the single quiet deferred price statement on that line.
    expect(markup).toContain("Priced at checkout");
    expect(markup).toContain('href="/checkout/buy/readiness"');
    expect(markup).toContain("Resolve item availability before payment starts.");
    expect(markup).not.toContain('action="/checkout/buy/readiness"');
    expect(markup).not.toContain("Check out");
    // The redundant per-line "Resolve before checkout" sentence is gone; the
    // badge now carries the per-item state once.
    expect(markup).not.toContain("Resolve this item before checkout or remove it from your cart.");
  });

  it("offers optional fulfillment savings as a secondary action before checkout starts", () => {
    const expensiveLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_hobby_shop",
      seller_options: [
        {
          listing_id: "lst_card_vault",
          seller_account_id: "acc_card_vault",
          seller_slug: "card-vault",
          seller_display_name: "Card Vault",
          seller_average_rating: "4.90",
          seller_review_count: 12,
          price_amount: "389.00",
          available_quantity: 2,
          product_summary: "Form: Raw | Condition: Near Mint",
        },
        {
          listing_id: "lst_hobby_shop",
          seller_account_id: "acc_hobby_shop",
          seller_slug: "hobby-shop",
          seller_display_name: "Hobby Shop",
          seller_average_rating: null,
          seller_review_count: 0,
          price_amount: "395.00",
          available_quantity: 2,
          product_summary: "Form: Raw | Condition: Near Mint",
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[expensiveLine]} />);

    expect(markup).toContain("Save $12.00 before checkout");
    expect(markup).toContain(
      "You can keep your current fulfillment or use the lower-cost option before checkout begins.",
    );
    expect(markup).toContain("Use lower price");
    expect(markup).toContain("&quot;decision&quot;:&quot;accepted&quot;");
    expect(markup).toContain("&quot;decision&quot;:&quot;declined&quot;");
    // Still exactly one primary action even with the optional savings path.
    const primaryStamps = markup.match(/data-primary-action-count="1"/g) ?? [];
    expect(primaryStamps.length).toBe(1);
    expect(markup).not.toContain("allocation");
  });

  it("shows a simple empty-cart recovery state", () => {
    const markup = renderToString(<CheckoutCartPage cartLines={[]} />);

    expect(markup).toContain("Your buy cart is empty");
    expect(markup).toContain("Browse the marketplace and add a product to start building a Buy Cart checkout.");
    expect(markup).toContain(
      "When you add items, checkout will show final shipping, tax, and payment details before you pay.",
    );
    expect(markup).toContain("Keep shopping");
    expect(markup).not.toContain("Estimated total");
    expect(markup).not.toContain("Check out");
  });
});
