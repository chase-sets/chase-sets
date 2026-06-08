# Catalog Integration Provider Option Query Controls

Provider option queries power Admin selectors for provider, language, set, product-line, product, SKU, and similar import scopes. They are Catalog control-plane reads over provider adapter transport, not unbounded live provider calls from every dropdown render.

## Ownership

Catalog owns option query declarations on Provider Integration Profiles, cache key policy, stale/degraded display states, Admin response metadata, cursor pagination at the Catalog API boundary, readiness surfacing, and reset policy for operational option-query cache rows.

Provider adapters own provider APIs, endpoint DTOs, auth, sessions, cooldowns, retries, rate limits, raw response parsing, provider-native pagination, and transport diagnostics.

## Cache Keys

The option-query cache key is a stable fingerprint over provider key, active profile version or active provider-list fingerprint, query kind or alias, language code, and parent value.

Cursor and limit are not part of the cache key. Catalog caches the resolved provider-neutral option list for that query scope, then slices it into cursor pages at the API boundary. This avoids repeated live calls as operators page or dependent selectors re-render.

## TTL And Stale Policy

Default policy:

- fresh TTL: 15 minutes;
- stale TTL: 24 hours;
- default page size: 50;
- max page size: 200.

A fresh cache hit returns `cache.status: "fresh"` and `cache.source: "cache"` without calling provider transport. A miss or explicit `forceRefresh=true` calls live provider transport, writes a new cache row, and returns `cache.source: "live"`.

If live transport fails and a stale entry is still inside the stale window, Catalog returns the stale page with `cache.status: "stale"`, `cache.degraded: true`, and diagnostic code `provider-option-query-stale-cache-used`. If no cached entry is available, the route returns a provider option query unavailable error rather than silently issuing repeated retries.

## Pagination

The Admin route returns `items`, `total`, `count`, `page.cursor`, `page.nextCursor`, `page.limit`, `page.hasMore`, and `cache` metadata.

Catalog cursors currently use `offset:<n>` over the cached result set. Future provider-native cursors can be folded into adapter-owned transport without changing the Admin response shape.

## Force Refresh And Cache-Only Rollout

`forceRefresh=true` bypasses fresh cache and attempts one live refresh. UI should expose force refresh only for operator roles allowed to run provider-affecting reads; #788 owns final RBAC and destructive-action permission policy.

`CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES=cache-only` is degraded read mode. It must not call live provider transport. It may serve fresh or stale cached options, and it surfaces cache-only status in Admin UI. `disabled` remains a hard rollout block.

## Degraded Provider UX

Admin selectors should avoid repeated live calls from dependent dropdowns and typeaheads, show cached/stale/cache-only/paginated/degraded states near the selector workflow, retain selected fallback values when lists are stale or unavailable, avoid provider raw error bodies in operator copy, and keep imports blocked when required parent values are missing.

## Diagnostics And Metrics

Provider adapters should emit transport diagnostics for provider reachability, auth, retryable status codes, cooldowns, and rate limits. The control plane maps those diagnostics into readiness and Admin option-query status.

Operational metrics should distinguish cache hit, cache miss, stale cache served, live refresh success, live refresh failure, cache-only unavailable, and provider retry-after or cooldown. The metrics owner is Catalog Source Observations until #787 promotes the broader observability/runbook packet.

## Fixtures And Tests

Tests should cover cache hit and miss, stale fallback after provider failure, cache-only mode with and without cache, cursor pagination over cached results, route metadata for cache and page state, and degraded provider responses such as 403, 429, 502, 503, and 504 through adapter diagnostics.

Fixture payloads should stay provider-owned and governed by Catalog Integration Data Governance. Option-query cache rows are operational cache, not retained provider evidence.

## Reset Policy

`catalog_provider_option_query_cache` is operational cache. Pre-launch reset deletes it; rollback does not restore it; bootstrap and Admin usage repopulate it through bounded option queries. Launch readiness must verify the table is empty after pre-launch wipe/rebuild.
