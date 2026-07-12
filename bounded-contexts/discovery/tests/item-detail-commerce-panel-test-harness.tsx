import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactElement } from "react";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
  DiscoveryReferenceRecordRef,
  ProductSchema,
} from "../support/client-support/contracts";
import DiscoveryItemDetailRoute from "../routes/item-detail";

export const baseListing: DiscoveryMarketListing = {
  listing_id: "listing_charizard",
  listing_slug: "charizard-base-set-listingcharizard",
  product_slug: "charizard-base-set-cat_charizard",
  account_id: "seller_1",
  inventory_item_id: "inventory_1",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [],
  product_summary: "Raw / Near Mint",
  storage_location_name: null,
  ship_from_code: null,
  price_amount: "399.99",
  shipping_allowance_percentage_bps: 500,
  quantity_cap: 2,
  status: "active",
  seller_display_name: "Chase Sets",
  visible_quantity: 2,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

export const baseOffer: DiscoveryOffer = {
  offer_id: "offer_charizard",
  buyer_account_id: "buyer_1",
  buyer_display_name: "Ash Ketchum",
  catalog_catalog_item_id: "cat_charizard",
  product_id: "cat_charizard::",
  item_title: "Charizard",
  item_subtitle: "Base Set 4/102 Holo Rare",
  selected_options: [],
  product_summary: "Raw / Near Mint",
  price_amount: "350.00",
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-04-28T00:00:00.000Z",
  updated_at: "2026-04-28T00:00:00.000Z",
};

export const baseAccountOfferMatch: DiscoveryAccountOfferMatch = {
  ...baseOffer,
  seller_available_quantity: 2,
  can_fulfill: true,
  in_sell_list: false,
};

export const alternateListing: DiscoveryMarketListing = {
  ...baseListing,
  listing_id: "listing_charizard_alt",
  account_id: "seller_2",
  inventory_item_id: "inventory_2",
  seller_display_name: "Card Vault",
  price_amount: "410.00",
  visible_quantity: 1,
};

export const alternateOffer: DiscoveryOffer = {
  ...baseOffer,
  offer_id: "offer_charizard_alt",
  buyer_account_id: "buyer_2",
  buyer_display_name: "Misty",
  price_amount: "360.00",
};

export const alternateAccountOfferMatch: DiscoveryAccountOfferMatch = {
  ...alternateOffer,
  seller_available_quantity: 1,
  can_fulfill: true,
  in_sell_list: false,
};

export const requiredSchema: ProductSchema = {
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
          label: "Raw",
          displayOrder: 0,
          numericValue: null,
        },
      ],
    },
  ],
};

export const variantSchema: ProductSchema = {
  ...requiredSchema,
  dimensions: [
    {
      ...requiredSchema.dimensions[0],
      allowedOptions: [
        ...requiredSchema.dimensions[0].allowedOptions,
        {
          optionId: "graded",
          code: "graded",
          label: "Graded",
          displayOrder: 1,
          numericValue: null,
        },
      ],
    },
  ],
};

export function captureItemDetailRailAnalytics() {
  const events: Array<Record<string, unknown>> = [];
  const handler = (event: Event) => {
    if (event instanceof CustomEvent && event.detail && typeof event.detail === "object") {
      events.push(event.detail as Record<string, unknown>);
    }
  };

  window.addEventListener("chase-sets:item-detail-rail-analytics", handler);

  return {
    events,
    stop: () => window.removeEventListener("chase-sets:item-detail-rail-analytics", handler),
  };
}

export function renderWithDataRouter(element: ReactElement) {
  const router = createMemoryRouter([
    {
      path: "/",
      element,
      action: async () => ({ status: "ok" }),
    },
  ]);

  return render(<RouterProvider router={router} />);
}

export function renderItemDetailRoute(loaderData: Record<string, unknown>) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <DiscoveryItemDetailRoute />,
      loader: async () => loaderData,
      action: async () => ({ status: "ok" }),
    },
  ]);

  return render(<RouterProvider router={router} />);
}

export function createItem(overrides: Partial<DiscoveryItemDetail> = {}): DiscoveryItemDetail {
  return {
    catalog_item_id: "cat_charizard",
    slug: "charizard-base-set-cat_charizard",
    language_code: "en",
    title_i18n: {},
    title: "Charizard",
    subtitle_i18n: {},
    subtitle: "Base Set 4/102 Holo Rare",
    display_badges: [],
    description_i18n: {},
    description: "The iconic Base Set Charizard.",
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
    market_listings: [baseListing],
    offer_demand_matches: [baseOffer],
    contents: [],
    included_in: [],
    updated_at: "2026-04-28T00:00:00.000Z",
    ...overrides,
  };
}

export function expansionReference(): DiscoveryReferenceRecordRef {
  const manufacturer: DiscoveryReferenceRecordRef = {
    referenceId: "ref_manufacturer",
    typeKey: "manufacturer",
    key: "the-pokemon-company-international",
    name: "The Pokemon Company International",
    attributes: { "homepage-url": "https://www.pokemon.com/us" },
    relationships: [],
    status: "active",
  };
  const productLine: DiscoveryReferenceRecordRef = {
    referenceId: "ref_product_line",
    typeKey: "product-line",
    key: "pokemon-trading-card-game",
    name: "Pokemon Trading Card Game",
    attributes: { "short-name": "Pokemon TCG" },
    relationships: [
      {
        relationshipType: "published-by",
        referenceId: manufacturer.referenceId,
        reference: manufacturer,
      },
    ],
    status: "active",
  };
  const series: DiscoveryReferenceRecordRef = {
    referenceId: "ref_series",
    typeKey: "series",
    key: "mega-evolution",
    name: "Mega Evolution",
    attributes: { "tcgdex-series-id": "mega-evolution" },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: productLine.referenceId,
        reference: productLine,
      },
    ],
    status: "active",
  };

  return {
    referenceId: "ref_expansion",
    typeKey: "expansion",
    key: "perfect-order",
    name: "Perfect Order",
    attributes: { "tcgdex-set-id": "me03", "card-count": 88 },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: series.referenceId,
        reference: series,
      },
    ],
    status: "active",
  };
}
