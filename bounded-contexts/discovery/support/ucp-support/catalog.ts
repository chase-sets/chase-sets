import { formatMoney } from "@chase-sets/localization";
import { createUcpEnvelope, type UcpEnvelope, type UcpMessage } from "@chase-sets/platform-runtime/ucp";
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
  context?: unknown;
  pagination?: unknown;
}>;

type UcpCatalogLookupBody = Readonly<{
  ids?: unknown;
  id?: unknown;
  filters?: unknown;
  context?: unknown;
}>;

type CatalogPriceFilter = Readonly<{
  min?: number;
  max?: number;
  currency: CurrencyInfo | null;
  hasBounds: boolean;
}>;

type CurrencyInfo = Readonly<{ code: string; exponent: number }>;
type CatalogProduct = Readonly<{
  variants: readonly Readonly<Record<string, unknown>>[];
  price_range: Readonly<{
    min: Readonly<{ amount: number; currency: string }>;
    max: Readonly<{ amount: number; currency: string }>;
  }>;
  [key: string]: unknown;
}>;

const PRICE_FILTER_IGNORED_CONTENT =
  "Price filter was not applied where its currency was absent or unsupported, or where a product is not priced only in that currency.";
const LISTINGS_OMITTED_CONTENT =
  "Some listings for this product were omitted because their price could not be presented in this product's currency.";

export function createDiscoveryUcpHandlers(items: DiscoveryItemsServices): DiscoveryUcpHandlers {
  const handlers = {
    search_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogSearchBody>(input);
      const filters = readObject(body.filters);
      const context = readObject(body.context);
      const priceFilter = readPriceFilter(filters.price, contextCurrency(context));
      const pagination = readObject(body.pagination);
      const requestedLimit = readNumber(pagination.limit) ?? readNumber(body.limit);
      const requestedCursor = readString(pagination.cursor) ?? readString(body.cursor);
      const categories = readStringArray(filters.categories);
      const result = await items.search.searchItems({
        search: readString(body.query),
        category: categories.length > 0 ? undefined : readString(filters.category),
        categories,
        tag: readString(filters.tag),
        blueprintId: readString(filters.blueprintId),
        language: readString(filters.language),
        cursor: requestedCursor,
        limit: Math.min(requestedLimit ?? 20, 20),
        priceMin:
          priceFilter.min === undefined || !priceFilter.currency
            ? undefined
            : minorBoundToMajor(priceFilter.min, priceFilter.currency),
        priceMax:
          priceFilter.max === undefined || !priceFilter.currency
            ? undefined
            : minorBoundToMajor(priceFilter.max, priceFilter.currency),
        priceCurrency: priceFilter.currency?.code,
        inStock: true,
        includeTotal: true,
      });
      const hydrated = await Promise.all(
        result.items.map(async (row) => {
          const detail = await items.detail.getItemDetail(row.catalog_item_id);
          const resolved = detail
            ? detailRowToProductResult(detail, input.request, contextCurrency(context), row)
            : null;
          return resolved ? applyPriceFilter(resolved, priceFilter) : null;
        }),
      );
      const products = hydrated.filter((entry): entry is CatalogProductResult => entry !== null);
      const paginationResponse = {
        has_next_page: Boolean(result.nextCursor),
        ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
        ...(result.total !== null && products.length === result.items.length ? { total_count: result.total } : {}),
      };

      return createUcpEnvelope(
        "success",
        {
          products: products.map((entry) => entry.product),
          count: products.length,
          total: result.total,
          next_cursor: result.nextCursor,
          pagination: paginationResponse,
          result_presentation: {
            component: "marketplace-results",
            title: "Marketplace results",
            empty_state: "No matching marketplace products are available right now.",
          },
        },
        catalogMessages(products, priceFilter, result.items, "search"),
      );
    },
    lookup_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const ids = readIds(body);
      const filters = readObject(body.filters);
      const context = readObject(body.context);
      const priceFilter = readPriceFilter(filters.price, contextCurrency(context));
      const resolved = await resolveProductIds(items, ids, input.request, contextCurrency(context), priceFilter);
      const products = resolved.map((entry) => entry.product);

      return createUcpEnvelope(
        "success",
        {
          products,
          count: products.length,
        },
        catalogMessages(resolved, priceFilter, [], "lookup"),
      );
    },
    get_product: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const { params } = input;
      const id = params.id || readString(body.id) || readIds(body)[0] || "";
      const item = id ? await items.detail.getItemDetail(id) : null;
      const filters = readObject(body.filters);
      const context = readObject(body.context);
      const priceFilter = readPriceFilter(filters.price, contextCurrency(context));
      const resolved = item ? detailRowToProductResult(item, input.request, contextCurrency(context)) : null;
      const filtered = resolved ? applyPriceFilter(resolved, priceFilter) : null;

      return filtered
        ? createUcpEnvelope(
            "success",
            { product: filtered.product },
            catalogMessages([filtered], priceFilter, [], "get_product"),
          )
        : createUcpEnvelope("error", {}, [
            {
              severity: "unrecoverable",
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
    description: { plain: row.description ?? row.subtitle ?? row.title },
    subtitle: row.subtitle,
    url: productUrl,
    image_urls: imageUrls,
    availability: availability(row.market_summary),
    price_range: {
      min: price(
        row.market_summary?.lowest_price_amount ?? null,
        row.market_summary?.lowest_price_currency_code ?? null,
      ),
      max: price(
        row.market_summary?.lowest_price_amount ?? null,
        row.market_summary?.lowest_price_currency_code ?? null,
      ),
    },
    variants: [],
    extensions: {
      chase_sets: {
        catalog_item_id: row.catalog_item_id,
        slug: row.slug,
        blueprint_id: row.blueprint_id,
        categories: readStringArray(row.category_names),
        tags: readStringArray(row.tags),
        primary_image_url: imageUrls[0] ?? null,
        price_display: priceDisplay(
          row.market_summary?.lowest_price_amount ?? null,
          row.market_summary?.lowest_price_currency_code ?? null,
        ),
        availability_display: availabilityDisplay(row.market_summary),
        marketplace: marketSummary,
        actions: marketplaceActions(productUrl, marketSummary.lowest_price ? marketSummary.total_visible_quantity : 0),
      },
    },
  };
}
type CatalogProductResult = Readonly<{
  product: CatalogProduct;
  presentmentCurrency: string;
  omittedListings: boolean;
  sourceCurrency: string | null;
  catalogItemId: string;
}>;

function detailRowToProductResult(
  row: DiscoveryItemDetailRow,
  request: Request,
  requestedCurrency: CurrencyInfo | null,
  searchRow?: DiscoverySearchItemRow,
): CatalogProductResult | null {
  const presentment = choosePresentment(row.market_listings, requestedCurrency);
  if (!presentment) return null;
  const base = searchRowToProduct(
    {
      ...(searchRow ?? row),
      category_names: categoryNames(row.categories),
      category_slugs: categorySlugs(row.categories),
      blueprint_name: null,
      search_rank: null,
    },
    request,
  );
  const variants = presentment.listings.map((listing) => listingToVariant(listing, row, request));
  const min = variants.reduce(
    (lowest, variant) => (variant.price.amount < lowest.amount ? variant.price : lowest),
    variants[0].price,
  );
  const max = variants.reduce(
    (highest, variant) => (variant.price.amount > highest.amount ? variant.price : highest),
    variants[0].price,
  );
  const product = {
    ...base,
    product_schema: row.product_schema,
    price_range: { min, max },
    variants,
  };
  return {
    product,
    presentmentCurrency: presentment.currency.code,
    sourceCurrency:
      searchRow?.market_summary?.lowest_price_currency_code ?? row.market_summary?.lowest_price_currency_code ?? null,
    omittedListings: presentment.omittedListings,
    catalogItemId: row.catalog_item_id,
  };
}

function listingToVariant(
  listing: DiscoveryItemDetailRow["market_listings"][number],
  row: DiscoveryItemDetailRow,
  request: Request,
) {
  const listingPrice = price(listing.price_amount, listing.price_currency_code);
  if (!listingPrice) throw new Error("eligible listing must have a price");
  return {
    id: listing.listing_id,
    title: listing.product_summary ?? row.title,
    description: { plain: listing.product_summary ?? row.title },
    price: listingPrice,
    availability: {
      status: listing.visible_quantity > 0 ? "available" : "unavailable",
      quantity: listing.visible_quantity,
    },
    seller: { account_id: listing.account_id, display_name: listing.seller_display_name },
    selected_options: listing.selected_options,
    extensions: {
      chase_sets: {
        listing_id: listing.listing_id,
        listing_slug: listing.listing_slug,
        listing_url: marketplaceUrl(request, `/listings/${listing.listing_slug}`),
        inventory_item_id: listing.inventory_item_id,
        catalog_item_id: row.catalog_item_id,
        product_id: listing.product_id,
        price_display: priceDisplay(listing.price_amount, listing.price_currency_code),
        availability_display: `${listing.visible_quantity} available`,
        actions: marketplaceActions(
          marketplaceUrl(request, `/listings/${listing.listing_slug}`),
          listing.visible_quantity,
        ),
      },
    },
  };
}

async function resolveProductIds(
  items: DiscoveryItemsServices,
  ids: readonly string[],
  request: Request,
  requestedCurrency: CurrencyInfo | null,
  priceFilter: CatalogPriceFilter,
) {
  const uniqueIds = [...new Set(ids)].slice(0, 20);
  const rows = await Promise.all(uniqueIds.map(async (id) => ({ id, row: await items.detail.getItemDetail(id) })));
  const byProduct = new Map<string, CatalogProductResult & { requestedIds: string[] }>();
  for (const { id, row } of rows) {
    if (!row) continue;
    const resolved = detailRowToProductResult(row, request, requestedCurrency);
    if (!resolved) continue;
    const filtered = applyPriceFilter(resolved, priceFilter);
    if (!filtered) continue;
    const existing = byProduct.get(filtered.catalogItemId);
    if (existing) existing.requestedIds.push(id);
    else byProduct.set(filtered.catalogItemId, { ...filtered, requestedIds: [id] });
  }
  return [...byProduct.values()].map((entry) => ({
    ...entry,
    product: {
      ...entry.product,
      variants: entry.product.variants.slice(0, 1).map((variant) => ({
        ...variant,
        inputs: entry.requestedIds.map((id) => ({ id, match: "featured" })),
      })),
    },
  }));
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

function contextCurrency(context: Readonly<Record<string, unknown>>): CurrencyInfo | null {
  return resolveCurrency(readString(context.currency));
}

function resolveCurrency(value: string | undefined): CurrencyInfo | null {
  if (!value) return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "currency",
    );
    if (supported && !supported.includes(code)) return null;
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    const resolved = formatter.resolvedOptions();
    if (resolved.currency !== code) return null;
    return { code, exponent: resolved.maximumFractionDigits };
  } catch {
    return null;
  }
}

function minorBoundToMajor(value: number, currency: CurrencyInfo): string {
  const raw = String(value);
  if (currency.exponent === 0) return raw;
  const padded = raw.padStart(currency.exponent + 1, "0");
  const split = padded.length - currency.exponent;
  return `${padded.slice(0, split)}.${padded.slice(split)}`;
}

function minorUnits(
  amount: string | null,
  currencyCode: string | null,
): { currency: CurrencyInfo; minor: bigint } | null {
  if (!amount || !currencyCode) return null;
  const currency = resolveCurrency(currencyCode);
  if (!currency || !/^\d+(?:\.\d+)?$/.test(amount.trim())) return null;
  const [whole, fraction = ""] = amount.trim().split(".");
  if (fraction.length > currency.exponent) return null;
  const digits = `${whole}${fraction.padEnd(currency.exponent, "0")}`;
  try {
    const minor = BigInt(digits);
    if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { currency, minor };
  } catch {
    return null;
  }
}

function priceFilterValue(value: unknown): number | undefined {
  const parsed = readNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readPriceFilter(value: unknown, currency: CurrencyInfo | null): CatalogPriceFilter {
  const filter = readObject(value);
  const min = priceFilterValue(filter.min);
  const max = priceFilterValue(filter.max);
  const hasBounds = min !== undefined || max !== undefined;
  return { min, max, hasBounds, currency: hasBounds ? currency : null };
}

function choosePresentment(
  listings: DiscoveryItemDetailRow["market_listings"],
  requestedCurrency: CurrencyInfo | null,
): Readonly<{
  currency: CurrencyInfo;
  listings: DiscoveryItemDetailRow["market_listings"];
  omittedListings: boolean;
}> | null {
  const eligible = listings
    .map((listing) => ({ listing, value: minorUnits(listing.price_amount, listing.price_currency_code) }))
    .filter(
      (entry): entry is { listing: (typeof listings)[number]; value: { currency: CurrencyInfo; minor: bigint } } =>
        entry.value !== null,
    );
  if (eligible.length === 0) return null;
  const groups = new Map<string, { currency: CurrencyInfo; listings: (typeof eligible)[number]["listing"][] }>();
  for (const entry of eligible) {
    const group = groups.get(entry.value.currency.code) ?? { currency: entry.value.currency, listings: [] };
    group.listings.push(entry.listing);
    groups.set(entry.value.currency.code, group);
  }
  const selected =
    (requestedCurrency && groups.get(requestedCurrency.code)) ??
    [...groups.values()].sort((a, b) => {
      const countDelta = b.listings.length - a.listings.length;
      return countDelta || a.currency.code.localeCompare(b.currency.code);
    })[0];
  if (!selected) return null;
  const selectedIds = new Set(selected.listings.map((listing) => listing.listing_id));
  const omittedListings = listings.some(
    (listing) => Boolean(listing.price_amount) && !selectedIds.has(listing.listing_id),
  );
  return { currency: selected.currency, listings: selected.listings, omittedListings };
}

function applyPriceFilter(result: CatalogProductResult, filter: CatalogPriceFilter): CatalogProductResult | null {
  if (!filter.hasBounds || !filter.currency || result.presentmentCurrency !== filter.currency.code) return result;
  const variants = result.product.variants.filter((variant) => {
    const amount = readNumber(readObject(variant.price).amount);
    return (
      amount !== undefined &&
      (filter.min === undefined || amount >= filter.min) &&
      (filter.max === undefined || amount <= filter.max)
    );
  });
  if (variants.length === 0) return null;
  const prices = variants.map((variant) => variant.price as { amount: number; currency: string });
  return {
    ...result,
    product: {
      ...result.product,
      variants,
      price_range: {
        min: prices.reduce((a, b) => (a.amount < b.amount ? a : b)),
        max: prices.reduce((a, b) => (a.amount > b.amount ? a : b)),
      },
    },
  };
}

function catalogMessages(
  products: readonly CatalogProductResult[],
  filter: CatalogPriceFilter,
  searchRows: readonly DiscoverySearchItemRow[],
  operation: "search" | "lookup" | "get_product",
): UcpMessage[] {
  const messages: UcpMessage[] = [];
  if (filter.hasBounds && !filter.currency) {
    messages.push({
      type: "warning",
      code: "price_filter_ignored",
      path: "$.filters.price",
      content: PRICE_FILTER_IGNORED_CONTENT,
    });
  } else if (filter.hasBounds && filter.currency) {
    const ignored = products.some((product) => product.sourceCurrency !== filter.currency!.code);
    if (ignored)
      messages.push({
        type: "warning",
        code: "price_filter_ignored",
        path: "$.filters.price",
        content: PRICE_FILTER_IGNORED_CONTENT,
      });
  }
  products.forEach((product, index) => {
    if (product.omittedListings) {
      messages.push({
        type: "warning",
        code: "listings_omitted_currency",
        path: operation === "get_product" ? "$.product" : `$.products[${index}]`,
        content: LISTINGS_OMITTED_CONTENT,
      });
    }
  });
  void searchRows;
  return messages;
}

function price(amount: string | null, currencyCode: string | null) {
  const value = minorUnits(amount, currencyCode);
  return value ? { currency: value.currency.code, amount: Number(value.minor) } : null;
}

function priceDisplay(amount: string | null, currencyCode: string | null) {
  return amount && currencyCode ? formatMoney(amount, currencyCode) : "Not currently listed";
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
    lowest_price: price(summary?.lowest_price_amount ?? null, summary?.lowest_price_currency_code ?? null),
    lowest_price_display: priceDisplay(
      summary?.lowest_price_amount ?? null,
      summary?.lowest_price_currency_code ?? null,
    ),
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
