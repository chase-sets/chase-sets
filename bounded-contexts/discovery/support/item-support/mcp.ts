import { formatMoney } from "@chase-sets/localization";
import { readMcpStringArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { createPublicProductUrlPolicy } from "@chase-sets/platform-runtime/public-product-urls";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";
import type { DiscoverySearchParams } from "../../features/search/read-model/queries";
import type { DiscoveryItemsServices } from "./runtime";
import { publicProductImages } from "./public-product-images";

export type DiscoveryItemMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function readOptionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return value;
}

function readMarketActivity(args: Readonly<Record<string, unknown>>): DiscoverySearchParams["marketActivity"] {
  const value = readMcpStringArgument(args, "marketActivity");
  if (!value) {
    return undefined;
  }
  if (value !== "listings" && value !== "offers" && value !== "any") {
    throw new Error("marketActivity must be listings, offers, or any.");
  }

  return value;
}

function readSearchParams(args: Readonly<Record<string, unknown>>): DiscoverySearchParams {
  return {
    search: readMcpStringArgument(args, "query") ?? readMcpStringArgument(args, "search") ?? undefined,
    category: readMcpStringArgument(args, "category") ?? undefined,
    tag: readMcpStringArgument(args, "tag") ?? undefined,
    blueprintId: readMcpStringArgument(args, "blueprintId") ?? undefined,
    language: readMcpStringArgument(args, "language") ?? undefined,
    marketActivity: readMarketActivity(args),
    sort: readMcpStringArgument(args, "sort") ?? undefined,
    cursor: readMcpStringArgument(args, "cursor") ?? undefined,
    limit: readOptionalPositiveInteger(args, "limit", 10),
    offset: readOptionalNonNegativeInteger(args, "offset", 0),
    includeTotal: true,
    status: "active",
  };
}

function isPublicItem(item: DiscoveryItemDetailRow | null): item is DiscoveryItemDetailRow {
  return item?.status === "active";
}

function itemUriParts(uri: string): Readonly<{ itemSlug: string }> | null {
  const match = /^chase-sets:\/\/discovery\/items\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return { itemSlug: decodeURIComponent(match[1] ?? "") };
}

function priceDisplay(amount: string | null | undefined, currencyCode: string | null | undefined) {
  return amount && currencyCode ? formatMoney(amount, currencyCode) : "Not currently listed";
}

function productFeedItem(
  item: DiscoveryItemDetailRow,
  resolve: ReturnType<typeof createPublicProductUrlPolicy>["resolve"],
) {
  const url = resolve(`/items/${item.slug}`) ?? null;
  return {
    id: item.catalog_item_id,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    url,
    image_url: publicProductImages(item, resolve)[0] ?? null,
    availability: {
      status: item.market_summary && item.market_summary.total_visible_quantity > 0 ? "in_stock" : "out_of_stock",
      quantity: item.market_summary?.total_visible_quantity ?? 0,
    },
    price: {
      currency: item.market_summary?.lowest_price_currency_code ?? null,
      amount: item.market_summary?.lowest_price_amount ?? null,
      display: priceDisplay(
        item.market_summary?.lowest_price_amount ?? null,
        item.market_summary?.lowest_price_currency_code ?? null,
      ),
    },
    variants: item.market_listings.map((listing) => ({
      id: listing.product_id,
      listing_id: listing.listing_id,
      title: listing.product_summary ?? item.title,
      url: resolve(`/listings/${listing.listing_slug}`) ?? null,
      price: {
        currency: listing.price_currency_code,
        amount: listing.price_amount,
        display: priceDisplay(listing.price_amount, listing.price_currency_code),
      },
      availability: {
        status: listing.visible_quantity > 0 ? "in_stock" : "out_of_stock",
        quantity: listing.visible_quantity,
      },
      seller: {
        display_name: listing.seller_display_name,
        rating: listing.seller_average_rating,
        review_count: listing.seller_review_count,
      },
      selected_options: listing.selected_options,
    })),
  };
}

export function createDiscoveryItemMcpHandlers(items: DiscoveryItemsServices): DiscoveryItemMcpHandlers {
  const searchMarket: McpToolHandler = async ({ arguments: args }) => {
    const result = await items.search.searchItems(readSearchParams(args));

    return {
      items: result.items,
      facets: result.facets,
      total: result.total,
      count: result.items.length,
      nextCursor: result.nextCursor,
    };
  };

  const getItemDetail: McpToolHandler = async ({ arguments: args }) => {
    const itemSlug = readMcpStringArgument(args, "itemSlug") ?? readMcpStringArgument(args, "id");
    if (!itemSlug) {
      throw new Error("itemSlug is required.");
    }

    const item = await items.detail.getItemDetail(itemSlug);
    if (!isPublicItem(item)) {
      throw new Error("Item not found.");
    }

    return item;
  };

  const getChatGptProductFeed: McpToolHandler = async ({ arguments: args, request }) => {
    const result = await items.search.searchItems(readSearchParams(args));
    const details = await Promise.all(result.items.map((item) => items.detail.getItemDetail(item.slug)));
    const { resolve } = createPublicProductUrlPolicy(request);
    const products = details.filter(isPublicItem).map((item) => productFeedItem(item, resolve));

    return {
      feedFormat: "chatgpt-product-feed/v1",
      products,
      total: result.total,
      count: products.length,
      nextCursor: result.nextCursor,
    };
  };

  const readItemResource: McpResourceHandler = async ({ uri }) => {
    const parts = itemUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported discovery item resource URI.");
    }

    const item = await items.detail.getItemDetail(parts.itemSlug);
    if (!isPublicItem(item)) {
      throw new Error("Item not found.");
    }

    return item;
  };

  return {
    toolHandlers: {
      "discovery.search-market": searchMarket,
      "discovery.get-item-detail": getItemDetail,
      "discovery.get-chatgpt-product-feed": getChatGptProductFeed,
    },
    resourceHandlers: {
      "chase-sets://discovery/items/{itemSlug}": readItemResource,
    },
  };
}
