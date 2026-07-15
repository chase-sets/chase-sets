// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { DiscoverySearchResponse } from "../../../support/request-support/api-client";
import {
  MAX_PERSISTED_SEARCH_EXTRA_PAGES,
  persistSearchExtraPages,
  restoreSearchExtraPages,
} from "./search-scroll-restoration";

describe("search scroll restoration", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("restores only cursor pages for the matching Result Set", () => {
    const pages = [page("second", "cursor_3")];

    persistSearchExtraPages(window.sessionStorage, "pikachu", pages);

    expect(restoreSearchExtraPages(window.sessionStorage, "pikachu")).toEqual(pages);
    expect(restoreSearchExtraPages(window.sessionStorage, "raichu")).toEqual([]);
    expect(restoreSearchExtraPages(window.sessionStorage, "pikachu")).toEqual([]);
  });

  it("caps persisted pages at a contiguous prefix so its final cursor remains resumable", () => {
    const pages = Array.from({ length: MAX_PERSISTED_SEARCH_EXTRA_PAGES + 2 }, (_, index) =>
      page(`page-${index + 2}`, `cursor_${index + 3}`),
    );

    persistSearchExtraPages(window.sessionStorage, "all-items", pages);

    const restored = restoreSearchExtraPages(window.sessionStorage, "all-items");
    expect(restored).toHaveLength(MAX_PERSISTED_SEARCH_EXTRA_PAGES);
    expect(restored.map((entry) => entry.items[0]?.catalog_item_id)).toEqual(
      pages.slice(0, MAX_PERSISTED_SEARCH_EXTRA_PAGES).map((entry) => entry.items[0]?.catalog_item_id),
    );
  });
});

function page(id: string, nextCursor: string | null): DiscoverySearchResponse {
  return {
    items: [
      {
        catalog_item_id: id,
        slug: id,
        language_code: "en",
        title_i18n: null,
        title: id,
        subtitle_i18n: null,
        subtitle: null,
        display_badges: [],
        description_i18n: null,
        description: "",
        blueprint_id: null,
        blueprint_name: null,
        status: "active",
        category_names: [],
        category_slugs: [],
        tags: [],
        image_urls: [],
        product_asset_sets: [],
        image_fallback: null,
        market_summary: {
          lowest_price_amount: null,
          active_listing_count: 0,
          total_visible_quantity: 0,
        },
        updated_at: "2026-07-15T00:00:00.000Z",
      },
    ],
    facets: [],
    total: null,
    count: 1,
    nextCursor,
    retrievalMode: "lexical",
    lexicalCount: 1,
  };
}
