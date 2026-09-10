// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("keeps Featured Categories authoritative and New Arrivals image-led", () => {
    const imageBearingArrival: DiscoverySearchItem = { ...newArrival, image_urls: ["/pikachu-jungle.webp"] };
    const { container } = render(
      <HomeMerchandising featuredCategories={[category]} newArrivals={[imageBearingArrival]} />,
    );

    // Featured Categories stay text-led entity navigation from authoritative
    // Category facts: name, description, item count, and link, with no image.
    const categoriesSection = screen.getByRole("heading", { name: "Featured categories" }).closest("section");
    expect(categoriesSection).toBeTruthy();
    const categoriesView = within(categoriesSection as HTMLElement);
    expect(categoriesView.getByText("Cards")).toBeTruthy();
    expect(categoriesView.getByText("Collectible cards across games and eras.")).toBeTruthy();
    expect(categoriesView.getByText("12 items")).toBeTruthy();
    expect(categoriesView.getByRole("link", { name: "Browse Cards" }).getAttribute("href")).toBe("/categories/cards");
    expect(categoriesSection!.querySelector("img")).toBeNull();
    expect(categoriesSection!.querySelector("article[data-card-layout]")).toBeNull();

    // New Arrivals stay image-led Product ListingCards through the unchanged
    // landed contract: an actual Product Asset image inside the card.
    const arrivalsSection = screen.getByRole("heading", { name: "New arrivals" }).closest("section");
    expect(arrivalsSection).toBeTruthy();
    const arrivalsView = within(arrivalsSection as HTMLElement);
    const card = arrivalsView.getByRole("heading", { name: "Pikachu" }).closest("article");
    expect(card?.getAttribute("data-card-layout")).toBe("search-result");
    const image = arrivalsView.getByRole("img", { name: "Pikachu — Jungle 60/64 Common" });
    expect(card?.contains(image)).toBe(true);
    expect(image.getAttribute("src")).toBe("/pikachu-jungle.webp");
    expect(
      arrivalsView.getByRole("link", { name: "View details for Pikachu — Jungle 60/64 Common" }).getAttribute("href"),
    ).toBe("/items/pikachu-cat_pikachu");

    // Browse all new arrivals lives in the section's actions slot: byte-identical
    // text and href, rendered in the section header ahead of the card grid.
    const browseAll = arrivalsView.getByRole("link", { name: "Browse all new arrivals" });
    expect(browseAll.getAttribute("href")).toBe("/search?sort=newest");
    expect(browseAll.textContent).toBe("Browse all new arrivals");
    expect(browseAll.compareDocumentPosition(card as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(browseAll.closest("section")).toBe(arrivalsSection);
    expect(card?.parentElement?.contains(browseAll)).toBe(false);
    expect(container.querySelectorAll("a[href='/search?sort=newest']")).toHaveLength(1);
  });

  it("renders the permanent Product image fallback when a New Arrival has no primary asset", () => {
    const fallbackArrival: DiscoverySearchItem = {
      ...newArrival,
      image_fallback: {
        url: "/fake-cdn/assets/pokemon-card-back.png",
        alt: "Pokemon TCG English card back",
        usage: "permanent",
        variants: {
          card: { oneX: "/fake-cdn/assets/pokemon-card-back.png", twoX: "/fake-cdn/assets/pokemon-card-back@2x.png" },
        },
      },
    };
    render(<HomeMerchandising featuredCategories={[]} newArrivals={[fallbackArrival]} />);

    const image = screen.getByRole("img", { name: "Pikachu — Jungle 60/64 Common" });
    expect(image.getAttribute("src")).toBe("/fake-cdn/assets/pokemon-card-back.png");
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
