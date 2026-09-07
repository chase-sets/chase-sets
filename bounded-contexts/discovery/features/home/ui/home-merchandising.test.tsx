// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type { DiscoverySearchItem } from "../../../support/client-support/contracts";
import { HomeMerchandising } from "./home-merchandising";

afterEach(cleanup);

const category: DiscoveryCategoryItem = {
  category_id: "ctg_cards",
  key: "cards",
  slug: "cards",
  name: "Cards",
  description: "Collectible cards across games and eras.",
  status: "active",
  parent_category_id: null,
  item_count: 12,
  display_order: 1,
  updated_at: "2026-07-15T00:00:00.000Z",
};

const newArrival: DiscoverySearchItem = {
  catalog_item_id: "cat_pikachu",
  slug: "pikachu-cat_pikachu",
  language_code: "en",
  title_i18n: {},
  title: "Pikachu",
  subtitle_i18n: {},
  subtitle: "Jungle 60/64 Common",
  display_badges: [],
  description_i18n: {},
  description: "A newly cataloged card.",
  blueprint_id: "bp_card",
  blueprint_name: "Card",
  status: "active",
  category_names: ["Cards"],
  category_slugs: ["cards"],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  market_summary: null,
  updated_at: "2026-07-15T00:00:00.000Z",
};

describe("HomeMerchandising", () => {
  it("renders featured category cards and new-arrival listing cards with canonical links", () => {
    render(<HomeMerchandising featuredCategories={[category]} newArrivals={[newArrival]} />);

    expect(screen.getByRole("heading", { name: "Featured categories" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse Cards" }).getAttribute("href")).toBe("/categories/cards");
    expect(screen.getByText("12 items")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New arrivals" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View details for Pikachu — Jungle 60/64 Common" }).getAttribute("href"),
    ).toBe("/items/pikachu-cat_pikachu");
    expect(screen.getByRole("link", { name: "Browse all new arrivals" }).getAttribute("href")).toBe(
      "/search?sort=newest",
    );
  });

  it("keeps whichever section has data when the other section is sparse", () => {
    const { rerender } = render(<HomeMerchandising featuredCategories={[category]} newArrivals={[]} />);

    expect(screen.getByRole("heading", { name: "Featured categories" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New arrivals" })).toBeNull();

    rerender(<HomeMerchandising featuredCategories={[]} newArrivals={[newArrival]} />);

    expect(screen.queryByRole("heading", { name: "Featured categories" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New arrivals" })).toBeTruthy();
  });

  it("keeps the localized Home price phrase while separating its Sans prefix from the mono value", () => {
    const pricedArrival: DiscoverySearchItem = {
      ...newArrival,
      market_summary: {
        lowest_price_amount: "17.95",
        active_listing_count: 1,
        total_visible_quantity: 1,
      },
    };

    const { container } = render(<HomeMerchandising featuredCategories={[]} newArrivals={[pricedArrival]} />);
    const prefix = container.querySelector("[data-listing-card-price-prefix]");
    const value = container.querySelector("[data-listing-card-price-value]");

    expect(prefix?.textContent).toBe("From");
    expect(prefix?.getAttribute("class")).toBeNull();
    expect(value?.textContent).toBe("$17.95");
    expect(value?.className).toBe("font-mono tabular-nums");
    expect(value?.parentElement?.textContent).toBe("From $17.95");
  });

  it("renders no competing empty state when the catalog has no merchandising data", () => {
    const { container } = render(<HomeMerchandising featuredCategories={[]} newArrivals={[]} />);

    expect(container.innerHTML).toBe("");
  });
});
