export const AUTH_SESSION_STATUSES = ["active", "revoked", "expired"] as const;

export type AuthSessionListFilters = Readonly<{ status: string; search: string }>;

/**
 * Reads the session admin list's status filter and search term from the request's URL so the
 * applied filters round-trip through links, form submissions, and browser navigation instead of
 * resetting on every load.
 */
export function readSessionListFilters(request: Request): AuthSessionListFilters {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status")?.trim() ?? "";

  return {
    status: (AUTH_SESSION_STATUSES as readonly string[]).includes(status) ? status : "all",
    search: searchParams.get("search")?.trim() ?? "",
  };
}

/**
 * Merges the session admin list's status/search filters into an existing `limit`/`offset` query
 * string (as built by `readOffsetPageParams`), producing the full query string to forward to the
 * Auth API.
 */
export function sessionListQuery(baseQuery: string, filters: AuthSessionListFilters): string {
  const query = new URLSearchParams(baseQuery);
  if (filters.status !== "all") {
    query.set("status", filters.status);
  }
  if (filters.search) {
    query.set("search", filters.search);
  }

  return query.toString();
}
