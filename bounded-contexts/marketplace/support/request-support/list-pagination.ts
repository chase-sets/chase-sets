const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;

/**
 * Builds the `limit`/`offset` query string for the seller's account listing list, reading
 * pagination state from the request's URL so page position round-trips through links and
 * browser navigation instead of resetting to the first page on every load.
 */
export function sellerListingPageQuery(request: Request): string {
  const searchParams = new URL(request.url).searchParams;
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || DEFAULT_LIMIT, MAX_LIMIT));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);

  return new URLSearchParams({ limit: String(limit), offset: String(offset) }).toString();
}
