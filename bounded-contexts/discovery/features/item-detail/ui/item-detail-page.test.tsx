// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DiscoveryItemDetail } from "../../../support/client-support/contracts";
import { ItemDetailPage } from "./item-detail-page";

const magicItem: DiscoveryItemDetail = {
  catalog_item_id: "cat_black_lotus",
  slug: "black-lotus",
  language_code: "en",
  title_i18n: {},
  title: "Black Lotus",
  subtitle_i18n: {},
  subtitle: null,
  display_badges: [],
  description_i18n: {},
  description: "",
  blueprint_id: null,
  blueprint: null,
  status: "active",
  field_values: [],
  categories: [],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  product_schema: null,
  market_summary: null,
  market_listings: [],
  offer_demand_matches: [],
  contents: [],
  included_in: [],
  updated_at: "2026-01-01T00:00:00.000Z",
};

afterEach(cleanup);

it("renders the game-neutral image for a Magic card with neither a picture nor a fallback", () => {
  render(<ItemDetailPage data={magicItem} />);

  expect(screen.getByRole("img", { name: "Default product image" }).getAttribute("src")).toBe(
    "/fake-cdn/assets/product-image-placeholder.svg",
  );
});

it("prefers the Catalog fallback when the Magic card has one", () => {
  const url = "/fake-cdn/assets/magic-card-back.svg";
  render(
    <ItemDetailPage
      data={{
        ...magicItem,
        image_fallback: { url, alt: "Magic: The Gathering card back", usage: "permanent", variants: {} },
      }}
    />,
  );

  expect(screen.getByRole("img", { name: "Magic: The Gathering card back" }).getAttribute("src")).toBe(url);
});

it("shows an item's one picture alone when it has no fallback, with no placeholder or thumbnails", () => {
  render(<ItemDetailPage data={{ ...magicItem, image_urls: ["/fake-cdn/items/black-lotus.jpg"] }} />);

  expect(screen.getByRole("img", { name: "Black Lotus image 1" }).getAttribute("src")).toContain(
    "/fake-cdn/items/black-lotus.jpg",
  );
  expect(screen.queryByRole("img", { name: "Default product image" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Black Lotus image 1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Default product image" })).toBeNull();
  // While the picture loads the placeholder may cover it, hidden from assistive technology; it is never a picture.
  for (const cover of document.querySelectorAll('img[src="/fake-cdn/assets/product-image-placeholder.svg"]')) {
    expect(cover.getAttribute("aria-hidden")).toBe("true");
  }
});

it("keeps an item's own permanent fallback as its last gallery picture", () => {
  const url = "/fake-cdn/assets/magic-card-back.svg";
  render(
    <ItemDetailPage
      data={{
        ...magicItem,
        image_urls: ["/fake-cdn/items/black-lotus.jpg"],
        image_fallback: { url, alt: "Magic: The Gathering card back", usage: "permanent", variants: {} },
      }}
    />,
  );

  const thumbnails = screen.getAllByRole("button", { name: /Black Lotus image 1|Magic: The Gathering card back/ });
  expect(thumbnails.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Black Lotus image 1",
    "Magic: The Gathering card back",
  ]);
  expect(screen.queryByRole("img", { name: "Default product image" })).toBeNull();
});
