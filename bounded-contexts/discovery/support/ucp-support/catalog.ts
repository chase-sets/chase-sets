import { formatMoney } from "@chase-sets/localization";
import { createUcpEnvelope, type UcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import type { DiscoveryItemsServices } from "../item-support/runtime";
import type { DiscoverySearchItemRow } from "../../features/search/read-model/queries";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";

type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;

export type DiscoveryUcpHandlers = Readonly<{
  restHandlers: Readonly<Record<string, UcpHandler>>;
  mcpToolHandlers: Readonly<Record<string, UcpHandler>>;
}>;

type UcpCatalogSearchBody = Readonly<{
  query?: unknown;
  limit?: unknown;
  cursor?: unknown;
  filters?: unknown;
}>;

type UcpCatalogLookupBody = Readonly<{
  ids?: unknown;
  id?: unknown;
}>;

export function createDiscoveryUcpHandlers(items: DiscoveryItemsServices): DiscoveryUcpHandlers {
  const handlers = {
    search_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogSearchBody>(input);
      const filters = readObject(body.filters);
      const result = await items.search.searchItems({
        search: readString(body.query),
        category: readString(filters.category),
        tag: readString(filters.tag),
        blueprintId: readString(filters.blueprintId),
        language: readString(filters.language),
        cursor: readString(body.cursor),
        limit: readNumber(body.limit),
        includeTotal: true,
      });

      return createUcpEnvelope("ok", {
        products: result.items.map((row) => searchRowToProduct(row, input.request)),
        count: result.items.length,
        total: result.total,
        next_cursor: result.nextCursor,
        result_presentation: {
          component: "marketplace-results",
          title: "Marketplace results",
          empty_state: "No matching marketplace products are available right now.",
        },
      });
    },
    lookup_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const ids = readIds(body);
      const products = await resolveProductIds(items, ids, input.request);

      return createUcpEnvelope("ok", {
        products,
        count: products.length,
      });
    },
    get_product: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const { params } = input;
      const id = params.id || readString(body.id) || readIds(body)[0] || "";
      const item = id ? await items.detail.getItemDetail(id) : null;

      return item
        ? createUcpEnvelope("ok", { product: detailRowToProduct(item, input.request) })
        : createUcpEnvelope("error", {}, [
            {
              severity: "error",
              code: "product_not_found",
              message: "Discovery could not resolve the requested product.",
              target: "id",
            },
          ]);
    },
  } satisfies Readonly<Record<string, UcpHandler>>;

  return {
    restHandlers: handlers,
    mcpToolHandlers: handlers,
  };
}

function searchRowToProduct(row: DiscoverySearchItemRow, request: Request) {
  const productUrl = marketplaceUrl(request, `/items/${row.slug}`);
  const imageUrls = productImageUrls(row);
  const marketSummary = marketplaceSummary(row.market_summary);
  return {
    id: row.catalog_item_id,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    url: productUrl,
    image_urls: imageUrls,
    availability: availability(row.market_summary),
    price: price(row.market_summary?.lowest_price_amount ?? null),
    extensions: {
      chase_sets: {
        catalog_item_id: row.catalog_item_id,
        slug: row.slug,
        blueprint_id: row.blueprint_id,
        categories: readStringArray(row.category_names),
        tags: readStringArray(row.tags),
        primary_image_url: imageUrls[0] ?? null,
        price_display: priceDisplay(row.market_summary?.lowest_price_amount ?? null),
        availability_display: availabilityDisplay(row.market_summary),
        marketplace: marketSummary,
        actions: marketplaceActions(productUrl, marketSummary.total_visible_quantity),
      },
    },
  };
}

function detailRowToProduct(row: DiscoveryItemDetailRow, request: Request) {
  return {
    ...searchRowToProduct(
      {
        ...row,
        category_names: categoryNames(row.categories),
        category_slugs: categorySlugs(row.categories),
        blueprint_name: null,
        search_rank: null,
      },
      request,
    ),
    product_schema: row.product_schema,
    variants: row.market_listings.map((listing) => ({
      id: listing.product_id,
      listing_id: listing.listing_id,
      title: listing.product_summary ?? row.title,
      price: price(listing.price_amount),
      availability: {
        status: listing.visible_quantity > 0 ? "available" : "unavailable",
        quantity: listing.visible_quantity,
      },
      seller: {
        account_id: listing.account_id,
        display_name: listing.seller_display_name,
      },
      selected_options: listing.selected_options,
      extensions: {
        chase_sets: {
          listing_id: listing.listing_id,
          listing_slug: listing.listing_slug,
          listing_url: marketplaceUrl(request, `/listings/${listing.listing_slug}`),
          inventory_item_id: listing.inventory_item_id,
          catalog_item_id: row.catalog_item_id,
          product_id: listing.product_id,
          price_display: priceDisplay(listing.price_amount),
          availability_display: `${listing.visible_quantity} available`,
          actions: marketplaceActions(
            marketplaceUrl(request, `/listings/${listing.listing_slug}`),
            listing.visible_quantity,
          ),
        },
      },
    })),
  };
}

async function resolveProductIds(items: DiscoveryItemsServices, ids: readonly string[], request: Request) {
  const rows = await Promise.all(ids.slice(0, 20).map((id) => items.detail.getItemDetail(id)));
  return rows
    .filter((row): row is DiscoveryItemDetailRow => row !== null)
    .map((row) => detailRowToProduct(row, request));
}

async function readJsonObject<T extends Readonly<Record<string, unknown>>>(request: Request): Promise<T> {
  const value = await request
    .clone()
    .json()
    .catch(() => ({}));
  return readObject(value) as T;
}

async function readInputObject<T extends Readonly<Record<string, unknown>>>(
  input: UcpOperationHandlerInput,
): Promise<T> {
  const args = input.arguments ?? {};
  return Object.keys(args).length > 0 ? (args as T) : readJsonObject<T>(input.request);
}

function readObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : undefined;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readRecordString(value: unknown, key: string) {
  const record = readObject(value);
  const entry = record[key];
  return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null;
}

function marketplaceUrl(request: Request, path: string) {
  const origin = new URL(request.url).origin;
  return new URL(path, origin).toString();
}

function categoryNames(value: unknown) {
  return readArray(value)
    .map((entry) => readRecordString(entry, "name"))
    .filter((entry): entry is string => entry !== null);
}

function categorySlugs(value: unknown) {
  return readArray(value)
    .map((entry) => readRecordString(entry, "slug"))
    .filter((entry): entry is string => entry !== null);
}

function productImageUrls(row: Pick<DiscoverySearchItemRow, "image_urls" | "product_asset_sets" | "image_fallback">) {
  const directUrls = readStringArray(row.image_urls);
  if (directUrls.length > 0) {
    return directUrls;
  }

  const fallbackUrl = readRecordString(row.image_fallback, "url");
  if (fallbackUrl) {
    return [fallbackUrl];
  }

  const urls: string[] = [];
  for (const assetSet of readArray(row.product_asset_sets)) {
    const variants = readArray(readObject(assetSet).variants);
    const preferred =
      variants.find((variant) =>
        ["search-card", "thumbnail", "catalog-detail"].includes(readRecordString(variant, "role") ?? ""),
      ) ?? readObject(assetSet).source;
    const publicUrl = readRecordString(preferred, "publicUrl");
    if (publicUrl) {
      urls.push(publicUrl);
    }
  }

  return [...new Set(urls)];
}

function readIds(body: UcpCatalogLookupBody) {
  if (Array.isArray(body.ids)) {
    return body.ids.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }

  const id = readString(body.id);
  return id ? [id] : [];
}

function price(amount: string | null) {
  return amount
    ? {
        currency: "USD",
        amount: moneyToMinorUnits(amount),
      }
    : null;
}

function priceDisplay(amount: string | null) {
  return amount ? formatMoney(amount, "USD") : "Not currently listed";
}

function availability(summary: DiscoverySearchItemRow["market_summary"]) {
  return {
    status: summary && summary.total_visible_quantity > 0 ? "available" : "unavailable",
    quantity: summary?.total_visible_quantity ?? 0,
    active_listing_count: summary?.active_listing_count ?? 0,
  };
}

function availabilityDisplay(summary: DiscoverySearchItemRow["market_summary"]) {
  const quantity = summary?.total_visible_quantity ?? 0;
  if (quantity <= 0) {
    return "Unavailable";
  }

  return `${quantity} available`;
}

function marketplaceSummary(summary: DiscoverySearchItemRow["market_summary"]) {
  return {
    status: summary && summary.total_visible_quantity > 0 ? "available" : "unavailable",
    lowest_price: price(summary?.lowest_price_amount ?? null),
    lowest_price_display: priceDisplay(summary?.lowest_price_amount ?? null),
    active_listing_count: summary?.active_listing_count ?? 0,
    total_visible_quantity: summary?.total_visible_quantity ?? 0,
  };
}

function marketplaceActions(url: string, availableQuantity: number) {
  return {
    view_product: {
      label: "View product",
      url,
    },
    create_checkout:
      availableQuantity > 0
        ? {
            label: "Create checkout",
            tool: "create_checkout",
          }
        : null,
  };
}

function moneyToMinorUnits(amount: string) {
  const normalized = amount.trim();
  const [dollars = "0", cents = ""] = normalized.split(".");
  const minor = `${dollars}${cents.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  return minor || "0";
}
