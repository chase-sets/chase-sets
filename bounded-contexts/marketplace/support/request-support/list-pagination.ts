const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const SELLER_LISTING_STATUSES = new Set(["draft", "active", "paused", "withdrawn"]);

export type SellerListingFilters = Readonly<{ status: string; search: string }>;

/**
 * Reads the seller listing workbench's status filter and title search from the request's
 * URL so the applied filters round-trip through links, form submissions, and browser
 * navigation instead of resetting on every load.
 */
export function sellerListingFilters(request: Request): SellerListingFilters {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status")?.trim() ?? "";

  return {
    status: SELLER_LISTING_STATUSES.has(status) ? status : "all",
    search: searchParams.get("search")?.trim() ?? "",
  };
}

/**
 * Builds the `limit`/`offset`/`status`/`search` query string for the seller's account listing
 * list, reading pagination and filter state from the request's URL so page position and
 * applied filters round-trip through links and browser navigation instead of resetting to the
 * first page or clearing filters on every load.
 */
export function sellerListingPageQuery(request: Request): string {
  const searchParams = new URL(request.url).searchParams;
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const { status, search } = sellerListingFilters(request);

  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status !== "all") {
    query.set("status", status);
  }
  if (search) {
    query.set("search", search);
  }

  return query.toString();
}
