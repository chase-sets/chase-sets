import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import {
  ItemCommercePanel,
  MarketplaceSellerRegistrationSection,
} from "../routes/item-detail";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  ProductSchema,
} from "../support/client-support/contracts";

const baseListing: DiscoveryMarketListing = {
  listing_id: "listing_charizard",
  account_id: "seller_1",
  inventory_record_id: "inventory_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [],
  product_summary: "Raw / Near Mint",
  storage_location_name: null,
  ship_from_code: null,
  price_amount: "399.99",
  quantity_cap: 2,
  status: "active",
  seller_display_name: "Chase Sets",
  visible_quantity: 2,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

const requiredSchema: ProductSchema = {
  canonicalDimensionOrder: [{ dimensionId: "form", dimensionName: "Form" }],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      valueKind: "unordered",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        {
          optionId: "raw",
          code: "raw",
          labels: [{ locale: "en", value: "Raw" }],
          displayOrder: 0,
          numericValue: null,
        },
      ],
    },
  ],
};

function createItem(
  overrides: Partial<DiscoveryItemDetail> = {},
): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    title: "Charizard",
    subtitle: "Base Set 4/102 Holo Rare",
    description: "The iconic Base Set Charizard.",
    blueprint_id: null,
    blueprint: null,
    status: "active",
    field_values: [],
    categories: [],
    tags: [],
    image_urls: [],
    product_schema: null,
    market_summary: null,
    market_listings: [baseListing],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("item detail commerce panel", () => {
  it("shows the sell tab when seller tools are represented by a registration CTA", () => {
    render(
      <ItemCommercePanel
        showSellerTab
        buyer={<div>Buy selected product</div>}
        seller={
          <MarketplaceSellerRegistrationSection
            productSummary="Raw / Near Mint"
            registerHref="/register?returnTo=%2Fitems%2Fcat_charizard"
          />
        }
      />,
    );

    expect(screen.getByRole("tab", { name: "Buy" })).toBeTruthy();
    const sellTab = screen.getByRole("tab", { name: "Sell" });
    expect(sellTab).toBeTruthy();

    fireEvent.click(sellTab);

    expect(screen.getByText("Sell on Chase Sets")).toBeTruthy();
    expect(screen.getByText("Start with: Raw / Near Mint")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Register to sell" }).getAttribute("href"))
      .toBe("/register?returnTo=%2Fitems%2Fcat_charizard");
  });

  it("opens the selected mobile commerce section in a drawer", () => {
    render(
      <ItemDetailPage
        data={createItem()}
        renderCommerce={() => ({
          desktop: <div>Desktop commerce panel</div>,
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Mobile sell action</div>,
        })}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Buy" })[0]);

    expect(screen.getByRole("dialog", { name: "Buy selected product" })).toBeTruthy();
    expect(screen.getByText("Mobile buy action")).toBeTruthy();
  });

  it("sends incomplete mobile selections back to the option chooser", () => {
    render(
      <ItemDetailPage
        data={createItem({
          product_schema: requiredSchema,
          market_listings: [],
        })}
        renderCommerce={() => ({
          desktop: <div>Desktop commerce panel</div>,
          buy: <div>Mobile buy action</div>,
          offer: <div>Mobile offer action</div>,
          sell: <div>Mobile sell action</div>,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Buy now" })).toBeNull();
    expect(
      screen
        .getAllByRole("link", { name: "Select options" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Choose to offer" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: "Choose to sell" })
        .every((link) => link.getAttribute("href") === "#select-options"),
    ).toBe(true);
  });
});
