// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./search-page";
import { productAlertSettingsHref } from "./product-alert-settings-link";
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
  display_badges: [],
  description_i18n: {},
  description: "A sealed Pokemon product.",
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
  display_badges: [],
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

const standardAbraSearchResult: DiscoverySearchItem = {
  ...japaneseSearchResult,
  catalog_item_id: "cat_abra_standard",
  slug: "abra-standard-cat_abra_standard",
  language_code: "en",
  title: "Abra",
  subtitle: "Base Set 43 Standard Set Common",
  description: "Standard set Abra",
  image_urls: ["/abra.webp"],
  market_summary: null,
};

const reverseAbraSearchResult: DiscoverySearchItem = {
  ...standardAbraSearchResult,
  catalog_item_id: "cat_abra_reverse",
  slug: "abra-reverse-cat_abra_reverse",
  subtitle: "Base Set 43 Parallel Set - Reverse Foil Common",
  description: "Parallel set Abra",
};

const searchResponse: DiscoverySearchResponse = {
  items: [searchResult],
  facets: [],
  total: 1,
  count: 1,
  nextCursor: null,
  retrievalMode: "lexical",
  lexicalCount: 1,
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
    marketActivity: "",
    priceMin: "",
    priceMax: "",
    inStock: false,
    sort: "relevance",
    dynamicFilters: [],
    data: searchResponse,
    categories,
    onSearchChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onLanguageChange: vi.fn(),
    onMarketActivityChange: vi.fn(),
    onPriceMinChange: vi.fn(),
    onPriceMaxChange: vi.fn(),
    onInStockChange: vi.fn(),
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
  it("allows wide desktop search result grids to use a third column", () => {
    renderSearchPage();

    expect(document.body.innerHTML).toContain("2xl:grid-cols-3");
  });

  it("keeps focused search and result detail links localized and accessible", () => {
    renderSearchPage({ committedSearch: "abra" });

    expect(screen.getByRole("searchbox", { name: "Marketplace search" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View details for Prismatic Evolutions Booster Pack — Pokemon sealed product" }),
    ).toBeTruthy();
  });

  it("formats search-card prices with the discovery money formatter", () => {
    renderSearchPage({
      committedSearch: "bulbasaur",
      data: { ...searchResponse, items: [japaneseSearchResult] },
    });

    expect(screen.getByText("From $10.00")).toBeTruthy();
  });

  it("uses Product Asset Set search variants before compatibility image URLs", () => {
    renderSearchPage({
      data: {
        ...searchResponse,
        items: [
          {
            ...searchResult,
            image_urls: ["https://assets.example/legacy-detail.webp"],
            product_asset_sets: [
              {
                kind: "product-image",
                sourceHash: "source_hash",
                source: {
                  role: "source",
                  width: 480,
                  height: 672,
                  density: null,
                  mediaType: "image/webp",
                  storageKey: "catalog/items/cat_test/product-image/source.webp",
                  publicUrl: "https://assets.example/source.webp",
                  byteSize: 100,
                  generatedAt: "2026-05-20T00:00:00.000Z",
                },
                variants: [
                  {
                    role: "search-card",
                    width: 224,
                    height: 314,
                    density: 1,
                    mediaType: "image/webp",
                    storageKey: "catalog/items/cat_test/product-image/search-card-224w-1x.webp",
                    publicUrl: "https://assets.example/search-card-224w.webp",
                    byteSize: 80,
                    generatedAt: "2026-05-20T00:00:00.000Z",
                  },
                  {
                    role: "search-card",
                    width: 448,
                    height: 627,
                    density: 2,
                    mediaType: "image/webp",
                    storageKey: "catalog/items/cat_test/product-image/search-card-448w-2x.webp",
                    publicUrl: "https://assets.example/search-card-448w.webp",
                    byteSize: 120,
                    generatedAt: "2026-05-20T00:00:00.000Z",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const image = screen.getByRole("img", { name: "Prismatic Evolutions Booster Pack — Pokemon sealed product" });
    expect(image.getAttribute("src")).toBe("https://assets.example/search-card-224w.webp");
    expect(image.getAttribute("srcset")).toBe(
      "https://assets.example/search-card-224w.webp 224w, https://assets.example/search-card-448w.webp 448w",
    );
    expect(image.getAttribute("sizes")).toBe("(min-width: 768px) 164px, 124px");
    expect(image.getAttribute("width")).toBe("224");
    expect(image.getAttribute("height")).toBe("314");
    expect(image.className).toContain("max-w-[7.25rem]");
  });

  it("prioritizes the first result row and keeps later result images lazy", () => {
    const items = Array.from({ length: 4 }, (_, index) => ({
      ...standardAbraSearchResult,
      catalog_item_id: `cat_abra_${index}`,
      slug: `abra-${index}`,
      title: `Abra ${index}`,
      image_urls: [`/abra-${index}.webp`],
    }));

    renderSearchPage({
      data: {
        ...searchResponse,
        items,
        total: items.length,
        count: items.length,
      },
    });

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(4);
    for (const image of images.slice(0, 3)) {
      expect(image.getAttribute("loading")).toBe("eager");
      expect(image.getAttribute("fetchpriority")).toBe("high");
    }
    expect(images[3]?.getAttribute("loading")).toBe("lazy");
    expect(images[3]?.getAttribute("fetchpriority")).toBe("auto");
  });

  it("gives compatibility image URLs intrinsic search-card dimensions", () => {
    renderSearchPage({
      data: {
        ...searchResponse,
        items: [standardAbraSearchResult],
      },
    });

    const image = screen.getByRole("img", { name: "Abra — Base Set 43 Standard Set Common" });
    expect(image.getAttribute("width")).toBe("224");
    expect(image.getAttribute("height")).toBe("314");
  });

  it("does not use card-back fallbacks as sealed-product search images", () => {
    renderSearchPage({
      data: {
        ...searchResponse,
        items: [
          {
            ...searchResult,
            image_fallback: {
              url: "/fake-cdn/assets/pokemon-card-back.png",
              alt: "Pokemon sealed product loading image",
              usage: "loading-only",
              variants: {
                card: {
                  oneX: "/fake-cdn/assets/pokemon-card-back.png",
                  twoX: "/fake-cdn/assets/pokemon-card-back.png",
                },
              },
            },
          },
        ],
      },
    });

    expect(screen.queryByRole("img", { name: "Prismatic Evolutions Booster Pack" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Pokemon sealed product loading image" })).toBeNull();
    expect(screen.queryByText("Product")).toBeNull();
    expect(screen.getByRole("heading", { name: "Prismatic Evolutions Booster Pack" })).toBeTruthy();
  });

  it("renders search result language codes as localized labels", () => {
    renderSearchPage({
      search: "bulbasaur",
      committedSearch: "bulbasaur",
      data: {
        items: [japaneseSearchResult],
        facets: [],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
      categories: [],
    });

    expect(screen.getAllByText("Japanese").length).toBeGreaterThan(0);
    expect(screen.queryByText("Language: ja")).toBeNull();
  });

  it("uses localized accessible labels for the results search and item links", () => {
    renderSearchPage({
      search: "bulbasaur",
      committedSearch: "bulbasaur",
      data: {
        items: [japaneseSearchResult],
        facets: [],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
      categories: [],
    });

    expect(screen.getByRole("searchbox", { name: "Marketplace search" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View details for Bulbasaur — Japanese Base Set" })).toBeTruthy();
  });

  it("formats search card prices through the discovery money formatter", () => {
    renderSearchPage({
      data: {
        ...searchResponse,
        items: [japaneseSearchResult],
      },
      categories: [],
    });

    expect(screen.getByText("From $10.00")).toBeTruthy();
  });

  it("labels semantic zero-result recovery as closest matches", () => {
    renderSearchPage({
      search: "electric mascot",
      committedSearch: "electric mascot",
      data: { ...searchResponse, retrievalMode: "rescue", lexicalCount: 0 },
    });

    expect(screen.getByRole("heading", { name: "Closest matches" })).toBeTruthy();
    expect(
      screen.getByText("No text matches were found. These related items are ranked by semantic similarity."),
    ).toBeTruthy();
    expect(screen.queryByText("No items found")).toBeNull();
  });

  it("surfaces catalog subtitles on search cards so visually identical variants can be distinguished", () => {
    renderSearchPage({
      committedSearch: "abra",
      data: {
        items: [standardAbraSearchResult, reverseAbraSearchResult],
        facets: [],
        total: 2,
        count: 2,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 2,
      },
      categories: [],
    });

    expect(screen.getAllByText("Abra")).toHaveLength(2);
    expect(screen.getByText("Base Set 43 Standard Set Common")).toBeTruthy();
    expect(screen.getByText("Base Set 43 Parallel Set - Reverse Foil Common")).toBeTruthy();
    expect(screen.queryByText("Pokemon Card Single")).toBeNull();
    expect(screen.queryByText("Make an offer or list yours to help this market form.")).toBeNull();
  });

  it("uses a scan-first search result card hierarchy", () => {
    renderSearchPage({
      committedSearch: "abra",
      data: {
        items: [standardAbraSearchResult],
        facets: [],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
      categories: [],
    });

    const title = screen.getByRole("heading", { name: "Abra" });
    const card = title.closest("article");

    expect(card?.getAttribute("data-card-layout")).toBe("search-result");
    expect(card?.querySelector('[data-card-promotion-placement="content"]')).toBeNull();
    expect(screen.queryByText("Supply wanted")).toBeNull();
    expect(screen.queryByText("Market open")).toBeNull();
    expect(screen.queryByText("Offers open")).toBeNull();
    expect(screen.queryByText("Offer or list yours")).toBeNull();
    expect(screen.queryByText("No active listings")).toBeNull();
    expect(screen.getByRole("link", { name: "View details for Abra — Base Set 43 Standard Set Common" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Abra — Base Set 43 Standard Set Common" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add product to Sell List" }).textContent).toBe("Sell");
    expect(screen.getByRole("link", { name: "Add product to Buy Cart" }).textContent).toBe("Buy");
    expect(screen.getByRole("link", { name: "Watch product" }).textContent).toBe("Watch");
  });

  it("renders language as a top-level desktop filter", () => {
    const props = renderSearchPage({ language: "ja" });

    expect(screen.getByText("Limit results to a catalog language.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(props.onLanguageChange).toHaveBeenCalledWith("en");
  });

  it("renders market activity as a reversible search filter", () => {
    const props = renderSearchPage({ marketActivity: "listings" });

    expect(screen.getByText("Market activity")).toBeTruthy();
    expect(screen.getByText("Show only items with matching listings or offer demand.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Listings" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Remove Market: Listings" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Offers" }));

    expect(props.onMarketActivityChange).toHaveBeenCalledWith("offers");

    fireEvent.click(screen.getByRole("button", { name: "Remove Market: Listings" }));

    expect(props.onMarketActivityChange).toHaveBeenCalledWith("");
  });

  it("renders localized price, in-stock, and price-sort controls with reversible chips", () => {
    const props = renderSearchPage({
      committedSearch: "cards",
      priceMin: "10.00",
      priceMax: "25.00",
      inStock: true,
      sort: "price_asc",
    });

    expect(screen.getByText("Price and availability")).toBeTruthy();
    expect(screen.getByText("Set a budget and choose whether results must be available now.")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Minimum price" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Maximum price" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "In stock" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Remove Minimum price: $10.00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Maximum price: $25.00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove In stock" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Sort: Price: low to high" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Minimum price: $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Maximum price: $25.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove In stock" }));

    expect(props.onPriceMinChange).toHaveBeenCalledWith("");
    expect(props.onPriceMaxChange).toHaveBeenCalledWith("");
    expect(props.onInStockChange).toHaveBeenCalledWith(false);
  });

  it("keeps the category facet visible when a category is selected", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    expect(screen.getByText("Browse categories")).toBeTruthy();
    expect(screen.getAllByText("1 results in Booster Packs").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Singles (7)" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Singles (7)" })[0]);

    expect(props.onCategoryChange).toHaveBeenCalledWith("singles");
  });

  it("keeps focused mobile category switching above recovery and saved-search content", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    const mobileFilters = screen.getByLabelText("Search filters");
    const savedSearch = screen.getByText("Save this search");

    expect(mobileFilters.compareDocumentPosition(savedSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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
        facets: [
          {
            id: "dim_condition",
            kind: "dimension",
            label: "Condition",
            values: [
              { id: "opt_near_mint", label: "Near Mint", count: 3, selected: true },
              { id: "opt_lightly_played", label: "Lightly Played", count: 2, selected: true },
              { id: "opt_excellent", label: "Excellent", count: 1, selected: false },
            ],
          },
        ],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
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
    expect(within(filterSheet).getByRole("button", { name: "Near Mint (3)" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(within(filterSheet).getByRole("button", { name: "Lightly Played (2)" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(within(filterSheet).getByRole("button", { name: "Excellent (1)" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "dimension",
      id: "dim_condition",
      value: "opt_excellent",
    });
  });

  it("renders reference facets with buyer-facing labels", () => {
    const props = renderSearchPage({
      dynamicFilters: [{ kind: "reference", id: "series", value: "ref_mega_evolution" }],
      data: {
        items: [searchResult],
        facets: [
          {
            id: "series",
            kind: "reference",
            label: "Series",
            values: [
              { id: "ref_mega_evolution", label: "Mega Evolution", count: 4, selected: true },
              { id: "ref_scarlet_violet", label: "Scarlet & Violet", count: 3, selected: false },
            ],
          },
        ],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
    });

    expect(screen.getByText("Series")).toBeTruthy();
    expect(screen.getByText("Narrow by rich catalog references on matching items.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scarlet & Violet (3)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Series: Mega Evolution" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "reference",
      id: "series",
      value: "ref_mega_evolution",
    });
  });

  it("searches within large dynamic facet option sets", () => {
    renderSearchPage({
      category: "booster-packs",
      data: {
        items: [searchResult],
        facets: [
          {
            id: "dim_condition",
            kind: "dimension",
            label: "Condition",
            values: Array.from({ length: 9 }, (_, index) => ({
              id: `opt_${index + 1}`,
              label: `Condition ${index + 1}`,
              count: 10 - index,
              selected: index === 0,
            })),
          },
        ],
        total: 1,
        count: 1,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
    });

    expect(screen.getByRole("button", { name: "Condition 1 (10)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Condition 9 (2)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Condition 9 (2)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: "Condition 9 (2)" })).toBeNull();

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
        retrievalMode: "lexical",
        lexicalCount: 1,
      },
    });

    expect(screen.getByRole("link", { name: "Add product to Buy Cart" }).getAttribute("href")).toBe(
      "/items/bulbasaur-cat_bulbasaur?dimension.dim_condition=opt_near_mint&dimension.dim_finish=opt_holo&market=buy",
    );
    expect(screen.getByRole("link", { name: "Add product to Sell List" }).getAttribute("href")).toBe(
      "/items/bulbasaur-cat_bulbasaur?dimension.dim_condition=opt_near_mint&dimension.dim_finish=opt_holo&market=sell",
    );
    expect(screen.getByRole("link", { name: "Watch product" }).getAttribute("href")).toBe(
      "/items/bulbasaur-cat_bulbasaur?dimension.dim_condition=opt_near_mint&dimension.dim_finish=opt_holo&market=watch",
    );
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
      readonly scrollMargin = "";
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

    fireEvent.click(screen.getByRole("button", { name: "Add matching products to Buy Cart" }));

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
            lines: [
              {
                catalog_item_id: "cat_bulbasaur",
                slug: "bulbasaur-cat_bulbasaur",
                title: "Bulbasaur",
                subtitle: "Japanese Base Set",
                image_url: null,
                image_srcset: null,
                image_loading_url: null,
                image_loading_alt: null,
                image_loading_srcset: null,
                product_id: "cat_bulbasaur::condition:raw",
                selected_options: [{ dimensionId: "condition", optionId: "raw" }],
                product_summary: "Condition: Raw",
                quantity: 1,
              },
            ],
            skippedItems: [
              {
                catalog_item_id: "cat_charizard",
                slug: "charizard-cat_charizard",
                title: "Charizard",
                reason: "product-options-required",
                message: "Condition is required before this item can be added.",
              },
            ],
          },
        },
      },
    });

    expect(screen.getByRole("dialog", { name: "Add matching products to Buy Cart" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Need options")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add eligible products" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("surfaces bulk add failures in a visible banner", () => {
    renderSearchPage({
      search: "base set",
      committedSearch: "base set",
      bulkAdd: {
        status: "idle",
        error: "We could not add matching products to Buy Cart. Try again.",
        onPreview: vi.fn(),
        onCommit: vi.fn(),
      },
    });

    expect(screen.getByText("Could not add matching products")).toBeTruthy();
    expect(screen.getByText("We could not add matching products to Buy Cart. Try again.")).toBeTruthy();
  });
});

// Regression coverage for #3809: /search previously shipped save-search CTAs that linked to
// `/account/saved-searches`, a route no bounded context registers. These tests read the real
// `deployableContributions` manifests (the same route registry the marketplace-web shell is
// generated from) so a future dead link on this page fails a unit test instead of shipping a 404.
type ManifestRouteContribution = Readonly<{
  deployable: string;
  routes: ReadonlyArray<{ routePath: string }>;
}>;

function readMarketplaceWebRoutePatterns(): ReadonlySet<string> {
  const boundedContextsRoot = join(__dirname, "..", "..", "..", "..");
  const contextDirNames = readdirSync(boundedContextsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const routePatterns = new Set<string>();

  for (const contextDirName of contextDirNames) {
    const manifestPath = join(boundedContextsRoot, contextDirName, "context.json");
    let manifest: { deployableContributions?: ReadonlyArray<ManifestRouteContribution> };

    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }

    for (const contribution of manifest.deployableContributions ?? []) {
      if (contribution.deployable !== "marketplace-web") {
        continue;
      }
      for (const route of contribution.routes) {
        routePatterns.add(`/${route.routePath.replace(/^\//, "")}`);
      }
    }
  }

  return routePatterns;
}

function matchesRegisteredRoute(pathname: string, routePatterns: ReadonlySet<string>): boolean {
  const pathSegments = pathname.split("/").filter(Boolean);

  for (const pattern of routePatterns) {
    const patternSegments = pattern.split("/").filter(Boolean);
    if (patternSegments.length !== pathSegments.length) {
      continue;
    }
    if (patternSegments.every((segment, index) => segment.startsWith(":") || segment === pathSegments[index])) {
      return true;
    }
  }

  return false;
}

function renderedLinkPathnames(): string[] {
  return Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .filter((href) => href.startsWith("/"))
    .map((href) => href.split("?")[0] ?? href);
}

describe("SearchPage route registrations", () => {
  it("keeps every link on a focused result set pointed at a route registered for marketplace-web", () => {
    const routePatterns = readMarketplaceWebRoutePatterns();

    renderSearchPage({
      committedSearch: "abra",
      data: { ...searchResponse, items: [standardAbraSearchResult, reverseAbraSearchResult] },
      bulkAdd: {
        status: "idle",
        data: {
          status: "bulk-added",
          preview: {
            eligibleCount: 1,
            skippedCount: 0,
            totalMatches: 1,
            limit: 50,
            overLimit: false,
            lines: [],
            skippedItems: [],
          },
          addedLineCount: 1,
          mergedLineCount: 0,
          failedLineCount: 0,
          requestedLineCount: 1,
        },
        onPreview: vi.fn(),
        onCommit: vi.fn(),
      },
    });

    const pathnames = renderedLinkPathnames();
    expect(pathnames.length).toBeGreaterThan(0);

    for (const pathname of pathnames) {
      expect(matchesRegisteredRoute(pathname, routePatterns), `expected ${pathname} to be a registered route`).toBe(
        true,
      );
    }
  });

  it("keeps every link on the zero-results recovery state pointed at a registered route", () => {
    const routePatterns = readMarketplaceWebRoutePatterns();

    renderSearchPage({
      committedSearch: "electric mascot",
      data: { ...searchResponse, items: [], total: 0, count: 0 },
    });

    const pathnames = renderedLinkPathnames();
    expect(pathnames.length).toBeGreaterThan(0);

    for (const pathname of pathnames) {
      expect(matchesRegisteredRoute(pathname, routePatterns), `expected ${pathname} to be a registered route`).toBe(
        true,
      );
    }
  });

  it("sends the zero-results save-search CTA to the working product-alerts settings surface, not the dead /account/saved-searches route", () => {
    renderSearchPage({
      committedSearch: "electric mascot",
      data: { ...searchResponse, items: [], total: 0, count: 0 },
    });

    const saveSearchLink = screen.getByRole("link", { name: "Save search" });
    expect(saveSearchLink.getAttribute("href")).toBe(productAlertSettingsHref);
  });

  it("sends the focused-results save-search prompt to the working product-alerts settings surface, not the dead /account/saved-searches route", () => {
    renderSearchPage({ committedSearch: "abra" });

    const saveSearchLink = screen.getByRole("link", { name: "Save search" });
    expect(saveSearchLink.getAttribute("href")).toBe(productAlertSettingsHref);
  });
});
