// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutCartPage } from "./cart-page";
import type { CheckoutCartLine } from "./contracts";

const productMeasureSnapshot = {
  catalogItemId: "cat_charizard",
  productId: "cat_charizard::condition:raw",
  selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
  measureVersion: "pm_test_raw_v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.02,
  unitWeightOunces: 0.08,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};

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
  selected_listing_id: null,
  selected_listing_seller_account_id: null,
  selected_listing_seller_display_name: null,
  selected_listing_seller_slug: null,
  selected_listing_price_amount: null,
  selected_listing_snapshot_source: null,
  selected_listing_snapshot_captured_at: null,
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
      available_quantity: 6,
      product_summary: "Form: Raw | Condition: Near Mint",
      product_measure_snapshot: productMeasureSnapshot,
    },
    {
      listing_id: "lst_hobby_shop",
      seller_account_id: "acc_hobby_shop",
      seller_slug: "hobby-shop",
      seller_display_name: "Hobby Shop",
      seller_average_rating: null,
      seller_review_count: 0,
      price_amount: "395.00",
      available_quantity: 4,
      product_summary: "Form: Raw | Condition: Near Mint",
      product_measure_snapshot: productMeasureSnapshot,
    },
  ],
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

function quantitySpinbutton() {
  return screen.getByRole("spinbutton", { name: "Quantity" }) as HTMLInputElement;
}

function submittedFormData(callIndex = 0) {
  return mockFetcherSubmit.mock.calls[callIndex]?.[0] as FormData;
}

function expectTintedFurniture(root: Element | null) {
  expect(root).toBeTruthy();
  const className = (root as HTMLElement).className;
  expect(className.split(/\s+/)).toContain("bg-surface-2");
  expect(className).not.toMatch(
    /\b(?:surface-border|ds-glass|border|border-muted|shadow-\S+|ds-glow|hover:border-accent|hover:shadow-tokenMd)\b/,
  );
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
    expect(markup).toContain("line-clamp-2");
    expect(markup).toContain("grid-cols-2 md:grid-cols-1");
    expect(markup).not.toContain("min-[420px]");
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

    const formData = submittedFormData();
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

  it("submits another quantity change after the first write is corrected by loader truth", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(1);

    rerender(<CheckoutCartPage cartLines={[{ ...cartLine, quantity: 3 }]} />);
    await waitFor(() => expect(quantitySpinbutton().value).toBe("3"));

    await user.click(screen.getByRole("button", { name: "Increase" }));

    await waitFor(() => expect(quantitySpinbutton().value).toBe("4"));
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(2);
    expect(submittedFormData(1).get("quantity")).toBe("4");
    expect(submittedFormData(1).get("optimisticSequence")).toBe("2");
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
    rerender(<CheckoutCartPage cartLines={[cartLine]} />);

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

    const formData = submittedFormData();
    expect(formData.get("quantity")).toBe("4");
    expect(formData.getAll("lineId")).toEqual(["cart_line_1", "cart_line_2"]);
  });

  it("removes a cart line optimistically and submits through the cart mutation controller", async () => {
    const user = userEvent.setup();
    render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByText("Your buy cart is empty")).toBeTruthy());
    expect(screen.queryByText("Estimated total")).toBeNull();
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(1);

    const formData = submittedFormData();
    expect(formData.get("intent")).toBe("remove-cart-line");
    expect(formData.getAll("lineId")).toEqual(["cart_line_1"]);
    expect(formData.get("sellerPreferenceId")).toBe("");
    expect(formData.get("optimisticStrategy")).toBe("optimistic-with-correction");
    expect(formData.get("correctionSource")).toBe("fresh-read:loader-revalidation");
    expect(formData.get("optimisticSequence")).toBe("1");
  });

  it("keeps an optimistically removed line hidden while stale loader data returns first", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("Your buy cart is empty")).toBeTruthy());

    mockUseFetcher.mockImplementation(() => ({
      state: "loading",
      data: null,
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(screen.getByText("Your buy cart is empty")).toBeTruthy();
    expect(screen.queryByText("Charizard")).toBeNull();

    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: null,
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(screen.getByText("Your buy cart is empty")).toBeTruthy();
    expect(screen.queryByText("Charizard")).toBeNull();
  });

  it("rolls back an optimistic remove when the route rejects the write", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CheckoutCartPage cartLines={[cartLine]} />);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("Your buy cart is empty")).toBeTruthy());

    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: { error: "Request failed." },
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[cartLine]} />);

    await waitFor(() => expect(screen.getByText("Charizard")).toBeTruthy());
    expect(screen.getByText("Checkout issue")).toBeTruthy();
    expect(screen.getAllByText("$778.00").length).toBeGreaterThan(0);
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
    expect(markup).toContain('data-optimistic-strategy="optimistic-with-correction"');
    expect(markup).not.toContain('value="lock-preferred-listing"');
    expect(markup).not.toContain("Locked listing");
  });

  it("locks the preferred listing optimistically and submits through the cart mutation controller", async () => {
    const user = userEvent.setup();
    const preferredLine: CheckoutCartLine = {
      ...cartLine,
      seller_preference_id: "lst_card_vault",
    };
    render(<CheckoutCartPage cartLines={[preferredLine]} />);

    await user.click(screen.getByRole("button", { name: "Lock this listing" }));

    await waitFor(() => expect(screen.getByText(/is locked for checkout unless availability changes/)).toBeTruthy());
    expect(screen.queryByText("Preferred listing")).toBeNull();
    expect(mockFetcherSubmit).toHaveBeenCalledTimes(1);

    const formData = submittedFormData();
    expect(formData.get("intent")).toBe("lock-preferred-listing");
    expect(formData.getAll("lineId")).toEqual(["cart_line_1"]);
    expect(formData.get("sellerPreferenceId")).toBe("lst_card_vault");
    expect(formData.get("optimisticStrategy")).toBe("optimistic-with-correction");
    expect(formData.get("correctionSource")).toBe("fresh-read:loader-revalidation");
    expect(formData.get("optimisticSequence")).toBe("1");
  });

  it("rolls back an optimistic preferred-listing lock when the route rejects the write", async () => {
    const user = userEvent.setup();
    const preferredLine: CheckoutCartLine = {
      ...cartLine,
      seller_preference_id: "lst_card_vault",
    };
    const { rerender } = render(<CheckoutCartPage cartLines={[preferredLine]} />);

    await user.click(screen.getByRole("button", { name: "Lock this listing" }));
    await waitFor(() => expect(screen.getByText(/is locked for checkout unless availability changes/)).toBeTruthy());

    mockUseFetcher.mockImplementation(() => ({
      state: "idle",
      data: { error: "Request failed." },
      submit: mockFetcherSubmit,
    }));
    rerender(<CheckoutCartPage cartLines={[preferredLine]} />);

    await waitFor(() => expect(screen.getByText("Preferred listing")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Lock this listing" })).toBeTruthy();
    expect(screen.getByText("Checkout issue")).toBeTruthy();
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

  it("uses the selected listing snapshot when seller options do not include the locked listing", () => {
    const lockedSnapshotLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_hobby_shop",
      selected_listing_id: "lst_hobby_shop",
      selected_listing_seller_account_id: "acc_hobby_shop",
      selected_listing_seller_display_name: "Hobby Shop",
      selected_listing_seller_slug: "hobby-shop",
      selected_listing_price_amount: "395.00",
      selected_listing_snapshot_source: "discovery.item-detail.add-to-cart",
      selected_listing_snapshot_captured_at: "2026-06-18T00:00:00.000Z",
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
          product_measure_snapshot: productMeasureSnapshot,
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[lockedSnapshotLine]} />);

    expect(markup).toContain("Hobby Shop");
    expect(markup).toContain("$790.00");
    expect(markup).not.toContain("$778.00");
    expect(markup).not.toContain(">from</p>");
  });

  it("falls back to the Standard badge when product_summary yields no options", () => {
    // A truthy summary that parses to zero usable options (only separators) must
    // not render an empty `ProductOptions` placeholder (#1936).
    const optionlessLine: CheckoutCartLine = {
      ...cartLine,
      product_summary: " | ",
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[optionlessLine]} />);

    expect(markup).toContain(">Standard</span>");
    expect(markup).not.toContain("No product options selected");
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
    expect(markup).toContain("1 item needs fulfillment, shipping measure, or availability resolved before checkout.");
    // The needs-review banner is warning-toned, not the default info-blue (#1932).
    expect(markup).toContain("bg-warning-soft");
    expect(markup).not.toContain("bg-info-soft");
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

  it("blocks checkout for a locked listing while its selected seller option is missing", () => {
    const lockedMissingOption: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_card_vault",
      selected_listing_id: "lst_card_vault",
      selected_listing_seller_account_id: "acc_card_vault",
      selected_listing_seller_display_name: "Card Vault",
      selected_listing_seller_slug: "card-vault",
      selected_listing_price_amount: "389.00",
      seller_options: [],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[lockedMissingOption]} />);

    expect(markup).toContain("Some items need attention");
    expect(markup).toContain("Waiting for supply");
    expect(markup).toContain("Continue to checkout");
    expect(markup).toContain('href="/checkout/buy/readiness"');
    expect(markup).not.toContain('action="/checkout/buy/readiness"');
    expect(markup).not.toContain("Check out");
  });

  it("blocks checkout and names a missing shipping measure for an otherwise available listing", () => {
    const missingMeasureLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_card_vault",
      seller_options: [
        {
          ...cartLine.seller_options[0]!,
          product_measure_snapshot: null,
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[missingMeasureLine]} />);

    expect(markup).toContain("Some items need attention");
    expect(markup).toContain("Shipping measure missing");
    expect(markup).toContain("Continue to checkout");
    expect(markup).toContain('href="/checkout/buy/readiness"');
    expect(markup).not.toContain('action="/checkout/buy/readiness"');
    expect(markup).not.toContain("Check out");
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
          product_measure_snapshot: productMeasureSnapshot,
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
          product_measure_snapshot: productMeasureSnapshot,
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[expensiveLine]} />);

    // The proposed lower-cost option (Card Vault) is named in the savings title.
    expect(markup).toContain("Save $12.00 by switching to Card Vault");
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

  it("shows the selected listing's seller rating on the cart line", () => {
    // The default optimize line resolves the lowest-cost option (Card Vault,
    // 4.90 from 12 reviews) as the seller it would check out.
    const markup = renderToString(<CheckoutCartPage cartLines={[cartLine]} />);

    expect(markup).toContain("Card Vault");
    // RatingSummary renders value.toFixed(1) and the review count in parentheses
    // (SSR splits the count into its own text node, so assert the parts).
    expect(markup).toContain("4.9");
    expect(markup).toContain(">12<");
    expect(markup).toContain('aria-label="Seller account reputation"');
  });

  it("renders the no-reviews empty state when the selected seller has no feedback yet", () => {
    const newSellerLine: CheckoutCartLine = {
      ...cartLine,
      fulfillment_mode: "locked-listing",
      locked_listing_id: "lst_hobby_shop",
      seller_options: [
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
          product_measure_snapshot: productMeasureSnapshot,
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[newSellerLine]} />);

    expect(markup).toContain("Hobby Shop");
    // Graceful empty state: no stars, the "No reviews yet" label instead.
    expect(markup).toContain("No reviews yet");
  });

  it("names the proposed seller and shows its rating in the optimization proposal", () => {
    // A locked Hobby Shop line (395.00) with a cheaper Card Vault option (389.00,
    // 4.90 from 12 reviews) yields a savings proposal that switches to Card Vault.
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
          product_measure_snapshot: productMeasureSnapshot,
        },
        {
          listing_id: "lst_hobby_shop",
          seller_account_id: "acc_hobby_shop",
          seller_slug: "hobby-shop",
          seller_display_name: "Hobby Shop",
          seller_average_rating: "4.10",
          seller_review_count: 5,
          price_amount: "395.00",
          available_quantity: 2,
          product_summary: "Form: Raw | Condition: Near Mint",
          product_measure_snapshot: productMeasureSnapshot,
        },
      ],
    };

    const markup = renderToString(<CheckoutCartPage cartLines={[expensiveLine]} />);

    // The savings notice names the proposed seller in its title.
    expect(markup).toContain("Save $12.00 by switching to Card Vault");
    // And renders the proposed seller's reputation alongside it (SSR splits the
    // count into its own text node, so assert the parts).
    expect(markup).toContain("4.9");
    expect(markup).toContain(">12<");
    expect(markup).toContain('aria-label="Seller account reputation"');
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

  it("shows pending fresh-write recovery instead of the normal empty-cart state", () => {
    const markup = renderToString(
      <CheckoutCartPage
        cartLines={[]}
        recoveryState={{
          kind: "pending-fresh-write",
          message: "We saved your cart change and are refreshing the cart view.",
          refreshHref: "/account/cart?afterWrite=receipt",
          isAutoRevalidating: true,
        }}
      />,
    );

    expect(markup).toContain("Your cart is catching up");
    expect(markup).toContain("We saved your cart change and are refreshing the cart view.");
    expect(markup).toContain("Updating cart");
    expect(markup).toContain("Refresh cart");
    expect(markup).toContain('href="/account/cart?afterWrite=receipt"');
    expect(markup).not.toContain("Your buy cart is empty");
    expect(markup).not.toContain("Browse the marketplace and add a product to start building a Buy Cart checkout.");
  });

  it("owns the checkout error and pending fresh-write roots as tinted furniture", () => {
    render(
      <CheckoutCartPage
        cartLines={[]}
        errorMessage="Checkout could not be refreshed."
        recoveryState={{
          kind: "pending-fresh-write",
          message: "We saved your cart change and are refreshing the cart view.",
          refreshHref: "/account/cart?afterWrite=receipt",
          isAutoRevalidating: true,
        }}
      />,
    );

    expectTintedFurniture(screen.getByText("Checkout issue").closest(".rounded-tokenLg"));
    expectTintedFurniture(
      screen.getByText("We saved your cart change and are refreshing the cart view.").closest(".rounded-tokenLg"),
    );
  });

  it("shows actionable empty-cart recovery for expired fresh-write handoffs", () => {
    const markup = renderToString(
      <CheckoutCartPage
        cartLines={[]}
        recoveryState={{
          kind: "missing-after-fresh-write",
          message:
            "The cart change was saved, but this cart view did not catch up in time. Refresh the cart or add the item again if it is still missing.",
          refreshHref: "/account/cart?afterWrite=expired",
        }}
      />,
    );

    expect(markup).toContain("Your buy cart is empty");
    expect(markup).toContain("The cart change was saved, but this cart view did not catch up in time.");
    expect(markup).toContain("Refresh cart");
    expect(markup).toContain("Keep shopping");
    expect(markup).toContain('href="/account/cart?afterWrite=expired"');
    expect(markup).not.toContain("Your cart is catching up");
  });
});
