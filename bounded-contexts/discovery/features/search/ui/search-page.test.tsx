// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./search-page";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type { DiscoverySearchItem, DiscoverySearchResponse } from "../../../support/client-support/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const categories: DiscoveryCategoryItem[] = [
  createCategory({ slug: "booster-packs", name: "Booster Packs", item_count: 1 }),
  createCategory({ slug: "generation-i", name: "Generation I", item_count: 5 }),
  createCategory({ slug: "fire", name: "Fire", item_count: 2 }),
  createCategory({ slug: "singles", name: "Singles", item_count: 7 }),
  createCategory({ slug: "pokemon-tcg", name: "Pokemon TCG", item_count: 10 }),
];

const searchResult: DiscoverySearchItem = {
  catalog_item_id: "cat_booster_pack",
  slug: "prismatic-evolutions-booster-pack-cat_booster_pack",
  language_code: "en",
  title_i18n: {},
  title: "Prismatic Evolutions Booster Pack",
  subtitle_i18n: {},
  subtitle: "Pokemon sealed product",
  description_i18n: {},
  description: "Make an offer or list yours to help this market form.",
  blueprint_id: null,
  blueprint_name: "Pokemon Sealed Product",
  status: "active",
  category_names: ["Booster Packs"],
  category_slugs: ["booster-packs"],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  market_summary: null,
  updated_at: "2026-05-13T00:00:00.000Z",
};

const japaneseSearchResult: DiscoverySearchItem = {
  catalog_item_id: "cat_bulbasaur",
  slug: "bulbasaur-cat_bulbasaur",
  language_code: "ja",
  title_i18n: null,
  title: "Bulbasaur",
  subtitle_i18n: null,
  subtitle: "Japanese Base Set",
  description_i18n: null,
  description: "Japanese printed Bulbasaur",
  blueprint_id: "bp_card",
  blueprint_name: "Pokemon Card Single",
  status: "active",
  category_names: ["Pokemon"],
  category_slugs: ["pokemon"],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  market_summary: {
    lowest_price_amount: "10.00",
    active_listing_count: 1,
    total_visible_quantity: 2,
  },
  updated_at: "2026-05-13T00:00:00.000Z",
};

const searchResponse: DiscoverySearchResponse = {
  items: [searchResult],
  facets: [],
  total: 1,
  count: 1,
  nextCursor: null,
};

function createCategory(overrides: Partial<DiscoveryCategoryItem>): DiscoveryCategoryItem {
  return {
    category_id: `cat_${overrides.slug ?? "category"}`,
    key: overrides.slug ?? "category",
    slug: overrides.slug ?? "category",
    name: overrides.name ?? "Category",
    description: "",
    status: "active",
    parent_category_id: null,
    item_count: overrides.item_count ?? 0,
    display_order: 0,
    updated_at: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderSearchPage(overrides: Partial<Parameters<typeof SearchPage>[0]> = {}) {
  const props: Parameters<typeof SearchPage>[0] = {
    search: "",
    committedSearch: "",
    category: "",
    language: "",
    sort: "relevance",
    dynamicFilters: [],
    data: searchResponse,
    categories,
    onSearchChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onLanguageChange: vi.fn(),
    onSortChange: vi.fn(),
    onDynamicFilterChange: vi.fn(),
    onDynamicFilterClear: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides,
  };

  render(<SearchPage {...props} />);

  return props;
}

describe("SearchPage", () => {
  it("renders search result language codes as localized labels", () => {
    renderSearchPage({
      search: "bulbasaur",
      committedSearch: "bulbasaur",
      data: { items: [japaneseSearchResult], facets: [], total: 1, count: 1, nextCursor: null },
      categories: [],
    });

    expect(screen.getAllByText("Japanese").length).toBeGreaterThan(0);
    expect(screen.queryByText("Language: ja")).toBeNull();
  });

  it("renders language as a top-level desktop filter", () => {
    const props = renderSearchPage({ language: "ja" });

    expect(screen.getByText("Limit results to a catalog language.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(props.onLanguageChange).toHaveBeenCalledWith("en");
  });

  it("keeps the category facet visible when a category is selected", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    expect(screen.getByText("Browse Categories")).toBeTruthy();
    expect(screen.getAllByText("1 results in Booster Packs").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Singles (7)" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Singles (7)" })[0]);

    expect(props.onCategoryChange).toHaveBeenCalledWith("singles");
  });

  it("keeps focused mobile category switching above recovery and saved-search content", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    const mobileFilters = screen.getByLabelText("Search filters");
    const savedSearch = screen.getByText("Save this search");

    expect(
      mobileFilters.compareDocumentPosition(savedSearch) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open filters" }));

    const filterSheet = screen.getByRole("dialog", { name: "Filters" });
    expect(within(filterSheet).getByText("Browse categories")).toBeTruthy();

    fireEvent.click(within(filterSheet).getByRole("button", { name: "Singles (7)" }));

    expect(props.onCategoryChange).toHaveBeenCalledWith("singles");
  });

  it("keeps applied category chips reversible", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    fireEvent.click(screen.getByRole("button", { name: "Remove Category: Booster Packs" }));

    expect(props.onCategoryChange).toHaveBeenCalledWith("");
  });

  it("renders dynamic facets and reversible dynamic filter chips", () => {
    const props = renderSearchPage({
      dynamicFilters: [
        { kind: "dimension", id: "dim_condition", value: "opt_near_mint" },
        { kind: "dimension", id: "dim_condition", value: "opt_lightly_played" },
      ],
      data: {
        items: [searchResult],
        facets: [{
          id: "dim_condition",
          kind: "dimension",
          label: "Condition",
          values: [
            { id: "opt_near_mint", label: "Near Mint", count: 3, selected: true },
            { id: "opt_lightly_played", label: "Lightly Played", count: 2, selected: true },
            { id: "opt_excellent", label: "Excellent", count: 1, selected: false },
          ],
        }],
        total: 1,
        count: 1,
        nextCursor: null,
      },
    });

    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.getByText("Condition")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Excellent (1)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Condition: Near Mint" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "dimension",
      id: "dim_condition",
      value: "opt_near_mint",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove Condition: Lightly Played" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "dimension",
      id: "dim_condition",
      value: "opt_lightly_played",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open filters" }));

    const filterSheet = screen.getByRole("dialog", { name: "Filters" });
    expect(within(filterSheet).queryByText("Advanced filters")).toBeNull();
    expect(within(filterSheet).getByText("Condition")).toBeTruthy();
    expect(within(filterSheet).getByRole("button", { name: "Near Mint (3)" })).toBeTruthy();
    expect(within(filterSheet).getByRole("button", { name: "Lightly Played (2)" })).toBeTruthy();
    expect(within(filterSheet).getByRole("button", { name: "Any Condition" })).toBeTruthy();
    expect(within(filterSheet).getByRole("button", { name: "Near Mint (3)" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(filterSheet).getByRole("button", { name: "Lightly Played (2)" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(filterSheet).getByRole("button", { name: "Excellent (1)" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "dimension",
      id: "dim_condition",
      value: "opt_excellent",
    });
  });

  it("searches within large dynamic facet option sets", () => {
    renderSearchPage({
      category: "booster-packs",
      data: {
        items: [searchResult],
        facets: [{
          id: "dim_condition",
          kind: "dimension",
          label: "Condition",
          values: Array.from({ length: 9 }, (_, index) => ({
            id: `opt_${index + 1}`,
            label: `Condition ${index + 1}`,
            count: 10 - index,
            selected: index === 0,
          })),
        }],
        total: 1,
        count: 1,
        nextCursor: null,
      },
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Condition options" }), {
      target: { value: "Condition 9" },
    });

    expect(screen.getByRole("button", { name: "Condition 1 (10)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Condition 9 (2)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Condition 2 (9)" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open filters" }));

    const drawer = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.change(within(drawer).getByRole("searchbox", { name: "Search Condition options" }), {
      target: { value: "missing" },
    });

    expect(within(drawer).getByText("No matching Condition options")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Condition 1 (10)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("carries dimension filters into item detail links without field filters", () => {
    renderSearchPage({
      committedSearch: "bulbasaur",
      dynamicFilters: [
        { kind: "dimension", id: "dim_condition", value: "opt_near_mint" },
        { kind: "dimension", id: "dim_finish", value: "opt_holo" },
        { kind: "field", id: "fld_seed_card_number", value: "44/102" },
      ],
      data: {
        items: [japaneseSearchResult],
        facets: [],
        total: 1,
        count: 1,
        nextCursor: null,
      },
    });

    expect(screen.getByRole("link", { name: "View details" }).getAttribute("href"))
      .toBe("/items/bulbasaur-cat_bulbasaur?dimension.dim_condition=opt_near_mint&dimension.dim_finish=opt_holo");
  });

  it("renders an accessible fallback action for cursor-loaded results", () => {
    const props = renderSearchPage({
      data: { ...searchResponse, nextCursor: "cursor_2" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("automatically requests the next cursor batch near the end of the result set", async () => {
    let observerCallback: IntersectionObserverCallback | null = null;
    class TestIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds: readonly number[] = [];
      disconnect = vi.fn();
      observe = vi.fn();
      takeRecords = vi.fn(() => []);
      unobserve = vi.fn();

      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const props = renderSearchPage({
      data: { ...searchResponse, nextCursor: "cursor_2" },
    });

    await waitFor(() => expect(observerCallback).toBeTruthy());
    act(() => {
      observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("renders loading state for cursor-loaded results", () => {
    renderSearchPage({
      data: { ...searchResponse, nextCursor: "cursor_2" },
      loadingMore: true,
    });

    expect(screen.getByText("Loading more results...")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more results" })).toHaveProperty("disabled", true);
  });

  it("renders retry state for cursor-loaded result failures", () => {
    const props = renderSearchPage({
      data: { ...searchResponse, nextCursor: "cursor_2" },
      loadMoreError: "More results could not load. Try again to continue browsing.",
    });

    expect(screen.getByText("Could not load more results")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading results" }));

    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("previews adding the focused result set to cart", () => {
    const onPreview = vi.fn();

    renderSearchPage({
      search: "base set",
      committedSearch: "base set",
      bulkAdd: {
        status: "idle",
        onPreview,
        onCommit: vi.fn(),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add matching to cart" }));

    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("summarizes eligible and skipped products before bulk adding", () => {
    const onCommit = vi.fn();

    renderSearchPage({
      search: "base set",
      committedSearch: "base set",
      bulkAdd: {
        status: "idle",
        onPreview: vi.fn(),
        onCommit,
        data: {
          status: "bulk-preview",
          preview: {
            totalMatches: 2,
            eligibleCount: 1,
            skippedCount: 1,
            overLimit: false,
            limit: 250,
            lines: [{
              catalog_item_id: "cat_bulbasaur",
              slug: "bulbasaur-cat_bulbasaur",
              title: "Bulbasaur",
              subtitle: "Japanese Base Set",
              image_url: null,
              image_loading_url: null,
              image_loading_alt: null,
              image_loading_srcset: null,
              product_id: "cat_bulbasaur::condition:raw",
              selected_options: [{ dimensionId: "condition", optionId: "raw" }],
              product_summary: "Condition: Raw",
              quantity: 1,
            }],
            skippedItems: [{
              catalog_item_id: "cat_charizard",
              slug: "charizard-cat_charizard",
              title: "Charizard",
              reason: "product-options-required",
              message: "Condition is required before this item can be added.",
            }],
          },
        },
      },
    });

    expect(screen.getByRole("dialog", { name: "Add matching products" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Need options")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add eligible products" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
