import { formatMoney } from "@chase-sets/localization";
import { readMcpStringArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";
import type { DiscoverySearchParams } from "../../features/search/read-model/queries";
import type { DiscoveryItemsServices } from "./runtime";

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

function primaryImageUrl(row: {
  image_urls: unknown;
  image_fallback: unknown;
  product_asset_sets: unknown;
}): string | null {
  if (Array.isArray(row.image_urls) && typeof row.image_urls[0] === "string") {
    return row.image_urls[0];
  }
  if (row.image_fallback && typeof row.image_fallback === "object") {
    const url = (row.image_fallback as Readonly<Record<string, unknown>>).url;
    if (typeof url === "string" && url.trim()) {
      return url;
    }
  }

  for (const assetSet of Array.isArray(row.product_asset_sets) ? row.product_asset_sets : []) {
    if (!assetSet || typeof assetSet !== "object") {
      continue;
    }
    const source = (assetSet as Readonly<Record<string, unknown>>).source;
    if (source && typeof source === "object") {
      const publicUrl = (source as Readonly<Record<string, unknown>>).publicUrl;
      if (typeof publicUrl === "string" && publicUrl.trim()) {
        return publicUrl;
      }
    }
  }

  return null;
}

function marketplaceUrl(request: Request, path: string) {
  return new URL(path, new URL(request.url).origin).toString();
}

function priceDisplay(amount: string | null | undefined) {
  return amount ? formatMoney(amount, "USD") : "Not currently listed";
}

function productFeedItem(item: DiscoveryItemDetailRow, request: Request) {
  const url = marketplaceUrl(request, `/items/${item.slug}`);
  return {
    id: item.catalog_item_id,
    title: item.title,
    subtitle: item.subtitle,
    description: item.description,
    url,
    image_url: primaryImageUrl(item),
    availability: {
      status: item.market_summary && item.market_summary.total_visible_quantity > 0 ? "in_stock" : "out_of_stock",
      quantity: item.market_summary?.total_visible_quantity ?? 0,
    },
    price: {
      currency: "USD",
      amount: item.market_summary?.lowest_price_amount ?? null,
      display: priceDisplay(item.market_summary?.lowest_price_amount ?? null),
    },
    variants: item.market_listings.map((listing) => ({
      id: listing.product_id,
      listing_id: listing.listing_id,
      title: listing.product_summary ?? item.title,
      url: marketplaceUrl(request, `/listings/${listing.listing_slug}`),
      price: {
        currency: "USD",
        amount: listing.price_amount,
        display: priceDisplay(listing.price_amount),
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
    const products = details.filter(isPublicItem).map((item) => productFeedItem(item, request));

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
