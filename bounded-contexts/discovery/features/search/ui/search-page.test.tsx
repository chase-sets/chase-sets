// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchPage } from "./search-page";

const searchItem = {
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

describe("SearchPage", () => {
  it("renders search result language codes as localized labels", () => {
    render(
      <SearchPage
        search="bulbasaur"
        committedSearch="bulbasaur"
        category=""
        language=""
        sort="relevance"
        page={0}
        data={{ items: [searchItem], total: 1, count: 1, nextCursor: null }}
        categories={[]}
        onSearchChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onLanguageChange={vi.fn()}
        onSortChange={vi.fn()}
        onPageChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Japanese")).toBeTruthy();
    expect(screen.queryByText("Language: ja")).toBeNull();
  });
});
