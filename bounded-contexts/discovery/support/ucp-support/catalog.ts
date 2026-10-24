import { formatMoney } from "@chase-sets/localization";
import { createUcpEnvelope, type UcpEnvelope, type UcpMessageInput } from "@chase-sets/platform-runtime/ucp";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import type { DiscoveryItemsServices } from "../item-support/runtime";
import type { DiscoverySearchItemRow } from "../../features/search/read-model/queries";
import type { DiscoveryItemDetailRow } from "../../features/item-detail/read-model/queries";
type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;

export type UcpCurrency = Readonly<{ code: string; exponent: number }>;

export type UcpCatalogListing = Pick<
  DiscoveryItemDetailRow["market_listings"][number],
  "listing_id" | "price_amount" | "price_currency_code"
>;

export type UcpPresentment<L extends UcpCatalogListing = UcpCatalogListing> = Readonly<{
  currency: string;
  listings: readonly L[];
  priceRange: Readonly<{ min: number; max: number }>;
  omittedListings: boolean;
}>;

export type UcpPresentmentBound = Readonly<{
  min?: number;
  max?: number;
  currency?: string | UcpCurrency | null;
}>;

export type CatalogUcpMode = "search" | "lookup" | "get_product";
export type CatalogUcpInput = Readonly<{ id: string; match: "featured" }>;

export const PRICE_FILTER_IGNORED_CONTENT =
  "Price filter was not applied where its currency was absent or unsupported, or where a product is not priced only in that currency.";

export const LISTINGS_OMITTED_CONTENT =
  "Some listings for this product were omitted because their price could not be presented in this product's currency.";

const supportedUcpCurrencies = new Set(Intl.supportedValuesOf("currency"));

export function resolveUcpCurrency(value: unknown): UcpCurrency | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !supportedUcpCurrencies.has(code)) return null;
  const exponent = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions()
    .maximumFractionDigits;
  return typeof exponent === "number" ? { code, exponent } : null;
}
export function toUcpMinorUnits(
  amount: unknown,
  currencyCode: unknown,
): Readonly<{ currency: string; minor: number }> | null {
  const currency = resolveUcpCurrency(currencyCode);
  if (!currency || typeof amount !== "string") return null;
  const normalized = amount.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const excess = fraction.slice(currency.exponent);
  if (excess.length > 0 && /[^0]/.test(excess)) return null;
  const minorText = `${whole}${fraction.slice(0, currency.exponent).padEnd(currency.exponent, "0")}`;
  try {
    const minor = BigInt(minorText);
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { currency: currency.code, minor: Number(minor) };
  } catch {
    return null;
  }
}

export function minorBoundToDecimal(bound: number, currency: string | UcpCurrency): string | null {
  const resolved = typeof currency === "string" ? resolveUcpCurrency(currency) : currency;
  if (!resolved || !Number.isSafeInteger(bound) || bound < 0) return null;
  const digits = String(bound).padStart(resolved.exponent + 1, "0");
  if (resolved.exponent === 0) return digits;
  const split = digits.length - resolved.exponent;
  return `${digits.slice(0, split)}.${digits.slice(split)}`;
}

function listingCurrency(listing: UcpCatalogListing) {
  return listing.price_currency_code;
}

function listingAmount(listing: UcpCatalogListing) {
  return listing.price_amount;
}

function eligibleListing<L extends UcpCatalogListing>(listing: L) {
  const converted = toUcpMinorUnits(listingAmount(listing), listingCurrency(listing));
  return converted ? { listing, ...converted } : null;
}

export function selectPresentment<L extends UcpCatalogListing>(
  listings: readonly L[],
  requestCurrency: unknown,
): UcpPresentment<L> | null {
  const eligible = listings.map(eligibleListing).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (eligible.length === 0) return null;
  const requested = resolveUcpCurrency(requestCurrency)?.code;
  const counts = new Map<string, number>();
  for (const entry of eligible) counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + 1);
  const selectedCurrency =
    requested && counts.has(requested)
      ? requested
      : [...counts.entries()].sort(([leftCode, leftCount], [rightCode, rightCount]) => {
          if (leftCount !== rightCount) return rightCount - leftCount;
          return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0;
        })[0]![0];
  const selected = eligible.filter((entry) => entry.currency === selectedCurrency);
  const selectedListings = selected.map((entry) => entry.listing);
  return {
    currency: selectedCurrency,
    listings: selectedListings,
    priceRange: {
      min: Math.min(...selected.map((entry) => entry.minor)),
      max: Math.max(...selected.map((entry) => entry.minor)),
    },
    omittedListings: listings.some((listing) => {
      const amount = listingAmount(listing);
      return typeof amount === "string" && amount.trim().length > 0 && !selectedListings.includes(listing);
    }),
  };
}

function boundCurrencyCode(value: UcpPresentmentBound["currency"]) {
  return typeof value === "string" ? (resolveUcpCurrency(value)?.code ?? null) : (value?.code ?? null);
}

export function boundPresentment<L extends UcpCatalogListing>(
  presentment: UcpPresentment<L>,
  bound: UcpPresentmentBound,
): (UcpPresentment<L> & Readonly<{ ignored: boolean }>) | null {
  const hasBounds = bound.min !== undefined || bound.max !== undefined;
  if (!hasBounds) return { ...presentment, ignored: false };
  if (boundCurrencyCode(bound.currency) !== presentment.currency) return { ...presentment, ignored: true };
  const filtered = presentment.listings.filter((listing) => {
    const converted = eligibleListing(listing);
    return (
      converted !== null &&
      (bound.min === undefined || converted.minor >= bound.min) &&
      (bound.max === undefined || converted.minor <= bound.max)
    );
  });
  if (filtered.length === 0) return null;
  const minors = filtered.map((listing) => eligibleListing(listing)!.minor);
  return {
    ...presentment,
    listings: filtered,
    priceRange: { min: Math.min(...minors), max: Math.max(...minors) },
    ignored: false,
  };
}

export function lookupInputs(
  pairs: readonly Readonly<{ requestedId: string; productId: string | null }>[],
): readonly Readonly<{ id: string; inputs: readonly Readonly<{ id: string; match: "featured" }>[] }>[] {
  const products = new Map<string, { id: string; inputs: Readonly<{ id: string; match: "featured" }>[] }>();
  for (const pair of pairs) {
    if (!pair.productId) continue;
    const product = products.get(pair.productId) ?? { id: pair.productId, inputs: [] };
    if (!product.inputs.some((input) => input.id === pair.requestedId)) {
      product.inputs.push({ id: pair.requestedId, match: "featured" });
    }
    products.set(pair.productId, product);
  }
  return [...products.values()];
}

/** Build the UCP 2026-08-25 Product resource from one native-currency presentment. */
export function catalogUcpProduct({
  source,
  presentment,
  request,
  mode,
  inputs = [],
}: Readonly<{
  source: DiscoveryItemDetailRow;
  presentment: UcpPresentment<DiscoveryItemDetailRow["market_listings"][number]>;
  request: Request;
  mode: CatalogUcpMode;
  inputs?: readonly CatalogUcpInput[];
}>) {
  const productUrl = marketplaceUrl(request, `/items/${source.slug}`);
  if (mode === "lookup" && inputs.length === 0) throw new Error("UCP lookup Product requires request inputs");
  const variants = presentment.listings.slice(0, mode === "lookup" ? 1 : undefined).map((listing) => {
    const price = toUcpMinorUnits(listing.price_amount, listing.price_currency_code);
    if (!price) throw new Error(`UCP Product listing ${listing.listing_id} has no exact presentment price.`);
    const listingUrl = marketplaceUrl(request, `/listings/${listing.listing_slug}`);
    return {
      id: listing.listing_id,
      title: listing.item_title ?? listing.product_summary ?? source.title,
      description: { plain: listing.product_summary ?? source.description },
      url: listingUrl,
      price: { currency: price.currency, amount: price.minor },
      extensions: {
        chase_sets: {
          catalog_item_id: source.catalog_item_id,
          slug: source.slug,
          listing_id: listing.listing_id,
          listing_slug: listing.listing_slug,
          inventory_item_id: listing.inventory_item_id,
          product_id: listing.product_id,
        },
      },
      ...(mode === "lookup" ? { inputs } : {}),
    };
  });
  return {
    id: source.catalog_item_id,
    title: source.title,
    description: { plain: source.description },
    url: productUrl,
    price_range: {
      min: { currency: presentment.currency, amount: presentment.priceRange.min },
      max: { currency: presentment.currency, amount: presentment.priceRange.max },
    },
    variants,
    extensions: {
      chase_sets: {
        catalog_item_id: source.catalog_item_id,
        slug: source.slug,
        listing_count: presentment.listings.length,
        omitted_listings: presentment.omittedListings,
      },
    },
  };
}

export type DiscoveryUcpHandlers = Readonly<{
  restHandlers: Readonly<Record<string, UcpHandler>>;
  mcpToolHandlers: Readonly<Record<string, UcpHandler>>;
}>;

type UcpCatalogSearchBody = Readonly<{
  query?: unknown;
  context?: unknown;
  pagination?: unknown;
  filters?: unknown;
}>;

type UcpCatalogLookupBody = Readonly<{
  ids?: unknown;
  id?: unknown;
  context?: unknown;
  filters?: unknown;
}>;

export function createDiscoveryUcpHandlers(items: DiscoveryItemsServices): DiscoveryUcpHandlers {
  const handlers = {
    search_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogSearchBody>(input);
      const filters = readObject(body.filters);
      const context = readObject(body.context);
      const pagination = readObject(body.pagination);
      const requestCurrency = resolveUcpCurrency(context.currency);
      const priceFilter = readObject(filters.price);
      const min = readMinorBound(priceFilter.min);
      const max = readMinorBound(priceFilter.max);
      const hasPriceBounds = min !== undefined || max !== undefined;
      const priceCurrency = requestCurrency?.code;
      const boundsAreUsable = Boolean(requestCurrency && hasPriceBounds);
      const warningMessages: UcpMessageInput[] = [];
      if (hasPriceBounds && !boundsAreUsable) {
        warningMessages.push({
          type: "warning",
          code: "price_filter_ignored",
          content: PRICE_FILTER_IGNORED_CONTENT,
        });
      }
      const result = await items.search.searchItems({
        search: readString(body.query),
        ...(readStringArray(filters.categories).length
          ? { categories: readStringArray(filters.categories) }
          : readString(filters.category)
            ? { category: readString(filters.category) }
            : {}),
        tag: readString(filters.tag),
        blueprintId: readString(filters.blueprintId),
        language: readString(filters.language),
        ...(readString(pagination.cursor) ? { cursor: readString(pagination.cursor) } : {}),
        ...(pagination.limit === undefined ? {} : { limit: clampLimit(readNumber(pagination.limit)) }),
        ...(priceCurrency ? { priceCurrency } : {}),
        ...(boundsAreUsable
          ? {
              ...(min === undefined ? {} : { priceMin: minorBoundToDecimal(min, requestCurrency!) ?? undefined }),
              ...(max === undefined ? {} : { priceMax: minorBoundToDecimal(max, requestCurrency!) ?? undefined }),
            }
          : {}),
        includeTotal: true,
      });
      const hydrated = await hydrateSearchRows(items, result.items.slice(0, 20), input.request, requestCurrency?.code);
      const products = hydrated.every((entry) => entry.product === null)
        ? result.items.slice(0, 20).map((row) => searchRowToProduct(row, input.request))
        : hydrated.flatMap((entry) => (entry.product ? [entry.product] : []));
      const dropped = hydrated.some((entry) => entry.product === null);
      for (const [index, entry] of hydrated.entries()) {
        if (!entry.product || !entry.presentment) continue;
        if (entry.presentment.omittedListings) {
          warningMessages.push({
            type: "warning",
            code: "listings_omitted_currency",
            content: LISTINGS_OMITTED_CONTENT,
            path: `$.products[${index}]`,
          });
        }
        if (requestCurrency && entry.presentment.currency !== requestCurrency.code) {
          warningMessages.push({
            type: "warning",
            code: "currency_mismatch",
            content: `This product is priced in ${entry.presentment.currency}, not ${requestCurrency.code}.`,
            path: `$.products[${index}]`,
          });
        }
      }
      return createUcpEnvelope(
        "success",
        {
          products,
          pagination: {
            has_next_page: Boolean(result.nextCursor),
            ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
            ...(!dropped && typeof result.total === "number" ? { total_count: result.total } : {}),
          },
        },
        warningMessages,
      );
    },
    lookup_catalog: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const ids = readIds(body);
      const context = readObject(body.context);
      const filters = readObject(body.filters);
      const requestedCurrency = resolveUcpCurrency(context.currency)?.code;
      const bound = readPriceBound(filters.price, context.currency);
      const products = await resolveProductIds(items, ids, input.request, requestedCurrency, bound);
      const warnings = products.flatMap((entry, index) => {
        const messages: UcpMessageInput[] = [];
        if (entry.presentment?.omittedListings)
          messages.push({
            type: "warning",
            code: "listings_omitted_currency",
            content: LISTINGS_OMITTED_CONTENT,
            path: `$.products[${index}]`,
          });
        if (entry.boundIgnored)
          messages.push({
            type: "warning",
            code: "price_filter_ignored",
            content: PRICE_FILTER_IGNORED_CONTENT,
            path: `$.products[${index}]`,
          });
        return messages;
      });
      return createUcpEnvelope(
        "success",
        { products: products.flatMap((entry) => (entry.product ? [entry.product] : [])) },
        warnings,
      );
    },
    get_product: async (input: UcpOperationHandlerInput) => {
      const body = await readInputObject<UcpCatalogLookupBody>(input);
      const { params } = input;
      const id = params.id || readString(body.id) || readIds(body)[0] || "";
      const item = id ? await items.detail.getItemDetail(id) : null;
      if (!item) {
        return createUcpEnvelope("error", {}, [
          {
            severity: "unrecoverable",
            code: "product_not_found",
            content: "The requested product was not found.",
            path: "$.product",
          },
        ]);
      }
      const context = readObject(body.context);
      const filters = readObject(body.filters);
      const presentment = selectPresentment(item.market_listings, resolveUcpCurrency(context.currency)?.code);
      const bound = readPriceBound(filters.price, context.currency);
      const bounded = presentment && boundPresentment(presentment, bound);
      if (!bounded)
        return createUcpEnvelope("error", {}, [
          {
            severity: "unrecoverable",
            code: "product_not_found",
            content: "The requested product was not found.",
            path: "$.product",
          },
        ]);
      const warnings: UcpMessageInput[] = [
        ...(presentment && bounded.ignored
          ? [{ type: "warning" as const, code: "price_filter_ignored", content: PRICE_FILTER_IGNORED_CONTENT }]
          : []),
        ...(bounded.omittedListings
          ? [
              {
                type: "warning" as const,
                code: "listings_omitted_currency",
                content: LISTINGS_OMITTED_CONTENT,
                path: "$.product",
              },
            ]
          : []),
      ];
      return createUcpEnvelope(
        "success",
        {
          product: catalogUcpProduct({
            source: item,
            presentment: bounded,
            request: input.request,
            mode: "get_product",
          }),
        },
        warnings,
      );
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
    price: price(
      row.market_summary?.lowest_price_amount ?? null,
      row.market_summary?.lowest_price_currency_code ?? null,
    ),
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
      price: price(listing.price_amount, listing.price_currency_code),
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
          price_display: priceDisplay(listing.price_amount, listing.price_currency_code),
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

async function resolveProductIds(
  items: DiscoveryItemsServices,
  ids: readonly string[],
  request: Request,
  currency: string | undefined,
  bound: UcpPresentmentBound,
) {
  const pairs = await Promise.all(
    ids.slice(0, 20).map(async (requestedId) => ({ requestedId, row: await items.detail.getItemDetail(requestedId) })),
  );
  const grouped = lookupInputs(
    pairs.map(({ requestedId, row }) => ({ requestedId, productId: row?.catalog_item_id ?? null })),
  );
  const rows = new Map(pairs.flatMap(({ row }) => (row ? [[row.catalog_item_id, row] as const] : [])));
  return grouped.flatMap((group) => {
    const row = rows.get(group.id);
    if (!row) return [];
    const presentment = selectPresentment(row.market_listings, currency);
    const bounded = presentment && boundPresentment(presentment, bound);
    return [
      {
        product: bounded
          ? catalogUcpProduct({
              source: row,
              presentment: bounded,
              request,
              mode: "lookup",
              inputs: group.inputs,
            })
          : null,
        presentment,
        boundIgnored: Boolean(bounded?.ignored),
      },
    ];
  });
}

async function hydrateSearchRows(
  items: DiscoveryItemsServices,
  rows: readonly DiscoverySearchItemRow[],
  request: Request,
  currency: string | undefined,
) {
  return Promise.all(
    rows.map(async (row) => {
      const detail = await items.detail.getItemDetail(row.catalog_item_id);
      const presentment = detail ? selectPresentment(detail.market_listings, currency) : null;
      return {
        product:
          detail && presentment ? catalogUcpProduct({ source: detail, presentment, request, mode: "search" }) : null,
        presentment,
      };
    }),
  );
}

function clampLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

function readMinorBound(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readPriceBound(value: unknown, currency: unknown): UcpPresentmentBound {
  const filter = readObject(value);
  const resolved = resolveUcpCurrency(currency);
  return {
    ...(readMinorBound(filter.min) === undefined ? {} : { min: readMinorBound(filter.min) }),
    ...(readMinorBound(filter.max) === undefined ? {} : { max: readMinorBound(filter.max) }),
    ...(resolved ? { currency: resolved } : {}),
  };
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

function price(amount: string | null, currencyCode: string | null) {
  const converted = amount && currencyCode ? toUcpMinorUnits(amount, currencyCode) : null;
  return converted ? { currency: converted.currency, amount: converted.minor } : null;
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
