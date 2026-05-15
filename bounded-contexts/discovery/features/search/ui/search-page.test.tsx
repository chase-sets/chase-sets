// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./search-page";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type { DiscoverySearchItem, DiscoverySearchResponse } from "../../../support/client-support/contracts";

afterEach(() => cleanup());

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
    page: 1,
    dynamicFilters: [],
    data: searchResponse,
    categories,
    onSearchChange: vi.fn(),
    onCategoryChange: vi.fn(),
    onLanguageChange: vi.fn(),
    onSortChange: vi.fn(),
    onDynamicFilterChange: vi.fn(),
    onDynamicFilterClear: vi.fn(),
    onPageChange: vi.fn(),
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

    expect(screen.getByText("Japanese")).toBeTruthy();
    expect(screen.queryByText("Language: ja")).toBeNull();
  });

  it("keeps the category facet visible when a category is selected", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    expect(screen.getByText("Browse Categories")).toBeTruthy();
    expect(screen.getByText("1 results in Booster Packs")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Singles (7)" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Singles (7)" })[0]);

    expect(props.onCategoryChange).toHaveBeenCalledWith("singles");
  });

  it("keeps focused mobile category switching above recovery and saved-search content", () => {
    renderSearchPage({ category: "booster-packs" });

    const mobileCategories = screen.getByLabelText("Browse categories");
    const savedSearch = screen.getByText("Save this search");

    expect(
      mobileCategories.compareDocumentPosition(savedSearch) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps applied category chips reversible", () => {
    const props = renderSearchPage({ category: "booster-packs" });

    fireEvent.click(screen.getByRole("button", { name: "Remove Category: Booster Packs" }));

    expect(props.onCategoryChange).toHaveBeenCalledWith("");
  });

  it("renders dynamic facets and reversible dynamic filter chips", () => {
    const props = renderSearchPage({
      dynamicFilters: [{ kind: "dimension", id: "dim_condition", value: "opt_near_mint" }],
      data: {
        items: [searchResult],
        facets: [{
          id: "dim_condition",
          kind: "dimension",
          label: "Condition",
          values: [
            { id: "opt_near_mint", label: "Near Mint", count: 3, selected: true },
            { id: "opt_excellent", label: "Excellent", count: 2, selected: false },
          ],
        }],
        total: 1,
        count: 1,
        nextCursor: null,
      },
    });

    expect(screen.getByText("Condition")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Near Mint (3)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Condition: Near Mint" }));

    expect(props.onDynamicFilterChange).toHaveBeenCalledWith({
      kind: "dimension",
      id: "dim_condition",
      value: "opt_near_mint",
    });
  });
});
