# Discovery Search Observability

Discovery owns the Search Query vocabulary and Result Set click event. The platform API owns Search Query signal export; the marketplace deployable owns capture of the browser event through the existing item-detail rail analytics bridge.

## Search Query signal

`searchItems` emits exactly one `DiscoverySearchQuerySignal` for every invocation, including failed retrievals. The payload contains a SHA-256 hash of normalized query text, an opaque SHA-256 Result Set key, Filter State names, Sort Order, fresh-versus-cursor state, result count, total when requested, zero-result state, retrieval mode, outcome, and normalization/retrieval/total timings.

The signal has one record per invocation. Exported metrics use only bounded Filter State, Sort Order, cursor state, zero-result, retrieval-mode, outcome, and timing-phase labels. Query hashes, Result Set keys, counts, totals, and raw query text are not metric labels.

## Result Set click

Selecting a Search Result card dispatches `search_result_selected` through `chase-sets:item-detail-rail-analytics`. Its payload includes the one-based click position, query hash, opaque Result Set key, and `surface=search_results`. The marketplace bridge forwards the same allowlisted payload to `/analytics/item-detail-rail`.

Raw query text, item identifiers, titles, account identifiers, and any Filter values are prohibited from both payloads. The query hash and Result Set key are correlation tokens only; they are never used as metric labels or logged by the capture route.

### Required click-field projection

The production `search_result_selected` payload is deliberately closed. Its required fields and their producer-to-consumer path are:

| Field | Producer | Consumer |
| --- | --- | --- |
| `event=search_result_selected` | `features/search/ui/search-page.tsx` | marketplace root bridge, then `/analytics/item-detail-rail` |
| `surface=search_results` | `features/search/ui/search-page.tsx` | marketplace root bridge, then `/analytics/item-detail-rail` |
| one-based `position` | `features/search/ui/search-page.tsx` | marketplace root bridge, then `/analytics/item-detail-rail` |
| SHA-256 `queryHash` | `features/search/api/runtime.ts` → `features/search/api/route.ts` → Discovery search loader → `features/search/ui/search-page.tsx` | marketplace root bridge, then `/analytics/item-detail-rail` |
| opaque SHA-256 `resultSetKey` | `features/search/api/runtime.ts` → `features/search/api/route.ts` → Discovery search loader → `features/search/ui/search-page.tsx` | marketplace root bridge, then `/analytics/item-detail-rail` |

The search UI dispatches the event only when both identities are non-empty. Empty identities are reserved for its explicit SSR failure fallback; the marketplace bridge independently accepts only 64-character lowercase SHA-256 values.

## Runtime contract inventory

`createDiscoveryItemSearchRuntime` remains wired by Discovery's item runtime and consumed by Search routes, item-support MCP, UCP catalog support, and API/acceptance tests. `suggestItems` remains exposed by the runtime but is not a Result Set invocation and does not emit this signal.
