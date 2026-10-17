# Discovery Search Observability

Discovery owns the Search Query vocabulary and Result Set click event. The platform API owns Search Query signal export; the marketplace deployable owns capture of the browser event through the existing item-detail rail analytics bridge.

## Search Query signal

`searchItems` emits exactly one best-effort `DiscoverySearchQuerySignal` for every invocation, including failed retrievals. An exporter exception cannot change the search result or error. The payload contains a SHA-256 hash of normalized query text, an opaque SHA-256 Result Set key, Filter State names, Sort Order, effective cursor state, result count, total when requested, final zero-result state, initial lexical-stage emptiness, interpretation outcome, retrieval mode, outcome, and normalization/retrieval/total timings.

Cursor state is the effective state, not raw cursor presence: `fresh` (no cursor), `cursor` (a cursor the active ordering or enabled hybrid retrieval continues), or `restarted` (a rejected cursor — unversioned, malformed, or from another retrieval mode — served as a fresh first page with full metadata and HTTP `cursorRestarted: true`). Failed retrievals report how their cursor classified.

`lexicalZero` observes whether the initial lexical read returned no rows, before interpretation, spelling correction, semantic rescue or hybrid fusion. It does not use totals: `includeTotal=false` still produces an observation, and `lexicalCount` retains its existing total semantics, including null when unavailable. Recovery never overwrites the observation: zero lexical rows followed by recovered rows means `lexicalZero=true` and `zeroResults=false`; one or two lexical rows followed by rescue means `lexicalZero=false`. An empty final lexical page is true/true. Hybrid observes its initial lexical candidate window, not the fused page or a later fallback.

Structured resolution bypasses lexical execution, so `lexicalZero=null`, not false. Failure before the initial lexical read completes is also unknown; a failed initial read is never replaced by a later successful fallback observation. If a later stage fails, preserve any completed lexical observation even though final `zeroResults` is null. Each invocation starts with an unknown observation. A lexical cursor page observes that page's emptiness, not a whole-query miss. A rejected cursor is evaluated afresh with `cursorState=restarted` and fresh stage/final observations, never the rejected page's emptiness. Invocation counters are not whole-query miss rates: separate fresh, cursor and restarted invocations, and exclude unknown lexical observations when measuring lexical misses.

The bounded `interpretation` outcome is `applied` only when the existing interpretation response is returned, `not-applied` on other successful retrievals (including discarded interpretations), and `unknown` on failed retrievals. Spelling correction remains `retrievalMode=corrected`; an interpreted result keeps its lexical or corrected mode, never a new interpreted mode. Together these labels distinguish corrected, interpreted, and interpreted-plus-corrected recoveries without exporting remaining query text, inferred Filter values, or display labels.

The query counter and normalization/retrieval/total histograms use only bounded Filter State, Sort Order, effective cursor state, final `zero_results=true|false|unknown`, initial `lexical_zero=true|false|unknown`, `interpretation=applied|not-applied|unknown`, retrieval-mode, outcome, query-embedding outcome, and timing-phase labels. Query hashes, Result Set keys, counts, totals, raw query text, Filter values, titles, and item/account identifiers are never metric labels or query logs. No raw query text is retained. These internal observations do not expand the HTTP, MCP, UCP, or browser click envelopes.

### Query embedding observations

The invocation signal adds `queryEmbeddingOutcome` and `queryEmbeddingWaiterDurationMs`, including failure/finally paths. Outcomes are `cache-hit` (warm reuse without I/O), `joined` (successful in-flight follower), `loaded` (successful owner), `timeout` (deadline or cancellation after waiting began), `error` (provider rejection or invalid vector), and `not-attempted` (ineligible, disabled, or pre-aborted). Failed followers report timeout/error, never joined or loaded. Skips and pre-aborts have zero waiter duration and no load observation.

`chase_sets_discovery_query_embedding_waiter_duration_ms` measures each attempted wait with only its outcome label. `chase_sets_discovery_query_embedding_load_duration_ms` measures shared provider work once, via the owner's independent completion callback, with only loaded/timeout/error labels. An owner disconnect can emit the invocation signal before its load observation; joins and warm hits never emit load duration or increment provider attempts. A staggered joined waiter has its own shorter wait, not a new provider load. Real-model cache-miss p50/p95 latency evidence must use the owner-only load histogram, never follower latency. Search counters expose the bounded `query_embedding_outcome` label, including not-attempted.

Both exports are best-effort. Embedding observations include no raw query, item/account ID, key or hash. No additional query logging or retention is introduced.

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

`createDiscoveryItemSearchRuntime` remains wired by Discovery's item runtime and consumed by Search routes (including home/category browse and portable search), item-support MCP/ChatGPT product feed, UCP catalog REST/MCP support, and API/acceptance tests. Discovery's runtime services forward its typed telemetry callbacks; platform API and platform worker both bind the same existing exporters. `suggestItems` and `previewBulkAdd` are not Result Set search invocations and do not emit this signal; set browse uses its own read model and is also excluded.
