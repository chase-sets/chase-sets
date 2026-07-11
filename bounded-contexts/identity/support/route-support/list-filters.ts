export const IDENTITY_USER_STATUSES = ["active", "suspended"] as const;
export const IDENTITY_ACCOUNT_STATUSES = ["active", "suspended", "closed"] as const;
export const IDENTITY_MEMBERSHIP_STATUSES = ["active", "revoked"] as const;
export const IDENTITY_INVITATION_STATUSES = ["pending", "accepted", "declined", "cancelled", "expired"] as const;
export const IDENTITY_API_KEY_STATUSES = ["active", "revoked"] as const;

export type IdentityListFilters = Readonly<{ status: string; search: string }>;

/**
 * Reads an identity admin list's status filter and search term from the request's URL so the
 * applied filters round-trip through links, form submissions, and browser navigation instead of
 * resetting on every load. `allowedStatuses` scopes the status filter to the resource's actual
 * status vocabulary; anything else (including no value) normalizes to `"all"`.
 */
export function readIdentityListFilters(request: Request, allowedStatuses: readonly string[]): IdentityListFilters {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status")?.trim() ?? "";

  return {
    status: allowedStatuses.includes(status) ? status : "all",
    search: searchParams.get("search")?.trim() ?? "",
  };
}

/**
 * Merges an identity admin list's status/search filters into an existing `limit`/`offset` query
 * string (as built by `readOffsetPageParams`), producing the full query string to forward to the
 * Identity API.
 */
export function identityListQuery(baseQuery: string, filters: IdentityListFilters): string {
  const query = new URLSearchParams(baseQuery);
  if (filters.status !== "all") {
    query.set("status", filters.status);
  }
  if (filters.search) {
    query.set("search", filters.search);
  }

  return query.toString();
}
