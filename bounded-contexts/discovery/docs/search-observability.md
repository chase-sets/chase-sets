# Discovery Search Observability

Discovery owns the Search Query vocabulary and Result Set click event. The platform API owns Search Query signal export; the marketplace deployable owns capture of the browser event through the existing item-detail rail analytics bridge.

## Search Query signal

`searchItems` emits exactly one `DiscoverySearchQuerySignal` for every invocation, including failed retrievals. The payload contains a SHA-256 hash of normalized query text, an opaque SHA-256 Result Set key, Filter State names, Sort Order, fresh-versus-cursor state, result count, total when requested, zero-result state, retrieval mode, outcome, and normalization/retrieval/total timings.

The signal has one record per invocation. Exported metrics use only bounded Filter State, Sort Order, cursor state, zero-result, retrieval-mode, outcome, and timing-phase labels. Query hashes, Result Set keys, counts, totals, and raw query text are not metric labels.

## Result Set click

Selecting a Search Result card dispatches `search_result_selected` through `chase-sets:item-detail-rail-analytics`. Its payload includes the one-based click position, query hash, opaque Result Set key, and `surface=search_results`. The marketplace bridge forwards the same allowlisted payload to `/analytics/item-detail-rail`.

Raw query text, item identifiers, titles, account identifiers, and any Filter values are prohibited from both payloads. The query hash and Result Set key are correlation tokens only; they are never used as metric labels or logged by the capture route.

## Runtime contract inventory

`createDiscoveryItemSearchRuntime` remains wired by Discovery's item runtime and consumed by Search routes, item-support MCP, UCP catalog support, and API/acceptance tests. `suggestItems` remains exposed by the runtime but is not a Result Set invocation and does not emit this signal.
