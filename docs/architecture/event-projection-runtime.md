# Event Projection Runtime

## Purpose

Projection consumers keep bounded-context read models current without coupling event publishers to downstream projectors. Publishers append integration facts to their own event store. Workers lease projection consumers, read matching source events, apply downstream handlers, and persist checkpoints.

## Production Push Posture

Push acceleration is live in staging; production and previews keep event-store wake emission, relay fan-out, and API wake-before-wait disabled by rollout controls while fallback polling remains the durable correctness path. Phase status lives in the [Push-Driven Projection Runtime Phase Map](./push-driven-projection-runtime-phase-map.md).

## Runtime Model

- A source context owns the event stream and publishes facts.
- A target context declares subscriptions in `context.json`.
- The shared bounded-context runtime creates subscription runners from those declarations.
- The platform worker runs projection groups as independent consumer runners.
- Checkpoints are stored per `projectionName:sourceContextName:version`.
- Poison handling is stream-isolated by default: one bad stream blocks only that projection plus stream.

## Operator States

Projection status uses these meanings:

- `caught-up`: checkpoint equals the captured source head and no active stream-isolated errors exist.
- `behind`: checkpoint is below the captured source head and no fresh runner status proves active draining.
- `running`: the worker control plane recently recorded a runner batch for the projection group.
- `degraded`: blocked streams or poison events require operator action.
- `error`: a runner failed outside stream-isolated poison handling.
- `idle`: local initial/transitional state only; positive backlog should not render as idle.

## Scaling Rules

Workers run projection consumers separately from bulk jobs, dispatchers, and scheduled jobs. Tune these independently:

- `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS`
- `WORKER_JOB_MAX_CONCURRENT_RUNNERS`
- `WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS`
- `WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS`

`WORKER_MAX_CONCURRENT_RUNNERS` remains the fallback for compatibility.

Projection subscriptions push event-type and stream-prefix filters into Postgres reads. This keeps each consumer independent while avoiding full source-log scans for every projection. When a filtered subscription has no matching tail left, it advances its checkpoint to the captured source head so irrelevant source events do not create permanent lag.

Global catch-up uses an advisory reader/writer fence. Append transactions take the shared side immediately before assigning `bigserial` positions and hold it through commit, so unrelated streams can still append concurrently. `readAll` and source-head capture take the exclusive side long enough to read the sequence's last allocated value, then bound their work to that horizon. Once the exclusive lock is granted, every lower allocation is either committed or permanently abandoned by rollback; later appends receive higher positions. The `event_store_events_global_position_seq` sequence must remain `CACHE 1`, which boot schema enforces, because a larger cache could issue a future position below a captured `last_value`. A bare `MAX(global_position)` or an unfenced `global_position > checkpoint` query is not a safe checkpoint horizon.

The Postgres event store keeps composite indexes for common projection scans: event type plus global position, tenant plus event type plus global position, and stream-prefix lookup plus global position. Query plans should be checked with production-like data before introducing new broad stream-prefix subscriptions. The partitioning and retention policy keeps that same cursor contract: `event_store_events` should partition by global-position ranges rather than `recorded_at` time ranges once the migration ledger from #2843 exists. See [Postgres Event Store Partitioning And Retention](./postgres-event-store-partitioning-retention.md).

Legacy `createProjector` consumers also push handler event types into `readAll` and batch checkpoint writes. New cross-context read models should still use bounded-context projection groups, but the compatibility path avoids full-log scans for existing slice-local projectors while they are migrated.

When a subscription does not explicitly declare `eventTypes`, the runtime derives its event-type filter from the handler map. If a subscription declares `eventTypes`, startup validation fails when any handler event type is missing from that declaration. A projection must not be allowed to silently checkpoint past an event it has a handler for.

API writes do not drain projections by default. Write responses expose source-context commit receipt metadata:

- `Chase-Sets-Commit-Position` is the maximum global position across all committed events for legacy scalar checks.
- `Chase-Sets-Commit-Receipt` is the canonical source-aware receipt. It carries each source context name, its committed event ids, and the maximum global position that projections must observe for that source.

Browser redirects that lead to read-model-backed pages carry that receipt as a short-lived `afterWrite` token. They may also carry `postWriteHandoff` query metadata when the destination needs to distinguish a stale `200` empty or stale resource shape from the outcome expected after the write. `postWriteHandoff` is browser-route metadata only; it is paired with `afterWrite`, is not forwarded as a new API header, and does not change the projection wait. Route request clients must use the canonical `@chase-sets/platform-runtime/http` forwarding helpers so server-side fetches preserve the token as `Chase-Sets-Read-After-Write`; context-owned request clients also set `Chase-Sets-Read-Target-Context` so shared mount paths such as `/api/marketplace` wait only on the context serving the read. Stale forwarding helpers that only copy auth headers are retired because they silently bypass freshness gates. API read consistency middleware then waits, within a bounded timeout, until the required projection groups are fresh for matching source contexts. A runner is fresh when its checkpoint covers the source position or, for an Inline Apply-eligible projection, one indexed ledger query proves that every real receipt event matching the runner's event-type and stream-prefix subscription is `applied`. Unknown event ids, active poison or blocked streams, ineligible runner shapes, missing event ids, and ledger query failures retain checkpoint-only behavior. If projections do not catch up in time, the API returns `projection_freshness_timeout` instead of serving a known-stale read model.

API mounts may declare `readFreshnessRoutes` in `context.json` for read-model-backed `GET` or `HEAD` routes that are reached immediately after a write. Each route names the mount-relative route path and one or more dependencies by `projectionName` or `readModelTable`. Table dependencies resolve through projection group `ownedTables`, so each read-model table used for freshness must have a single projection group owner. When a route declaration matches, freshness waits only on those exact projection groups and only on source contexts present in both the receipt and the selected dependency runners. Shared mount paths must forward `Chase-Sets-Read-Target-Context`; if two contexts expose the same route shape under one mount, the target-context header selects the owning route declaration so unrelated contexts do not wait. Routes without declarations keep the existing target-context fallback so migration can proceed incrementally.

Platform API can tune the read consistency gate without code changes. `READ_CONSISTENCY_TIMEOUT_MS` and `READ_CONSISTENCY_POLL_INTERVAL_MS` set global wait behavior. `READ_CONSISTENCY_ROUTE_TUNING_JSON` can tune timeout, poll interval, or exact-dependency mode for a specific `mountPath` plus mount-relative `routePath`, optionally scoped to a `targetContextName`. Critical defaults are registered first and keep precedence over equally specific env entries; use a more specific `targetContextName` entry for an intentional operator override. `READ_CONSISTENCY_EXACT_DEPENDENCY_MODE=target-context` is a global incident rollback that keeps `afterWrite` receipt waits active while falling back from exact projection dependencies to the broader target-context wait. Operators must prefer the smallest route-scoped override that restores safety; removing freshness manifests or disabling receipt forwarding would reintroduce stale permanent not-found behavior.

Fresh-write route ownership is declared in each bounded context's `readAfterWriteRouteInventory` manifest entries and validated by `pnpm run check:structure`. The check scans route modules for fresh-write and semantic handoff helpers, including `appendFreshWriteToken`, `appendFreshWriteTokenFromSources`, `appendPostWriteHandoff`, `appendPostWriteHandoffFromSources`, `loadFreshlyWrittenResource`, `readPostWriteHandoff`, `readPostWriteHandoffState`, and `evaluatePostWriteHandoff`, then verifies that each helper use is represented by inventory metadata or a dated owner-approved exception. Critical entries without exceptions must point at a matching `readFreshnessRoutes` declaration, list the destination read-model tables or projection dependencies, and document the transient recovery behavior. When semantic handoffs are consumed, transient recovery must also describe the route-owned pending behavior for valid unmet expectations. The generated review report is written to `artifacts/read-after-write-route-inventory.md`.

Exceptions are temporary migration records, not permanent bypasses. They must name the owner, status, reason, and `reviewBy` date. Use `accepted` for known projection-backed gaps that are still being migrated, `not-read-model-backed` for helper uses that do not depend on projection catch-up, and `not-post-write-read` for token-carrying handoffs whose post-write read belongs to another owning context. Renew or remove exceptions during route migrations and release hardening; #1084 cannot close while critical customer-facing helper uses remain unexplained or unowned.

Route authors must follow the [Read-After-Write Route Author Checklist](./read-after-write-route-author-checklist.md) when adding or changing post-write projection reads. Use [Semantic Post-Write Handoffs](./semantic-post-write-handoffs.md) only when a successful command can be hidden by stale `200` empty, stale unchanged resource, or `404`; durable job/status flows should stay job/status driven. The checklist is the durable contract for exact dependency targeting, inventory fields, exception format, cookie-backed continuations, local checks, canonical Checkout and Payments examples, and performance expectations for immediate-read projections.

Detail loaders may still use bounded not-found retry as a compatibility fallback, but the system-wide pattern is receipt propagation plus projection checkpoint gating. Synchronous write-drain is an explicit compatibility mode only, not the normal consistency contract.

## Fresh-Write Recovery Policy

Read-model `404` responses are permanent by default. A route may treat a `404` as transient only when the current URL carries a valid, unexpired `afterWrite` receipt. Fresh-write receipts are short lived, with a small clock-skew allowance for redirects whose timestamp is slightly ahead of the route server. Malformed, far-future, and expired tokens must not trigger retries. Customer-facing routes that can plausibly be reached immediately after a write should prefer safe expired-token copy, such as asking the buyer to restart checkout and confirming that payment has not started, instead of showing a resource-centric not-found message. The same rule applies to `projection_freshness_timeout`: the API returns HTTP `503` when projection checkpoints do not catch up inside the bounded wait, and browser routes may render temporary recovery only while the same fresh-write receipt remains valid. Checkout session reads also bound their server-side API fetch below the outer platform gateway timeout so an opaque `502`, `503`, or `504` during a valid receipt window can become Checkout-owned temporary recovery instead of a generic platform error page.

The shared `@chase-sets/http/responses` helper `classifyFreshWriteReadError` owns this classification. Route loaders provide the current request and the API error. The helper returns the parsed receipt, HTTP status, API error code, and whether the state is transient. It classifies:

- fresh receipt plus `404` as `transient-not-found`
- fresh receipt plus `503 projection_freshness_timeout` as `transient-projection-timeout`
- fresh receipt plus an opaque bounded `502`, `503`, or `504` gateway/service timeout as `transient-gateway-timeout`
- missing, malformed, future-dated, or expired receipts plus `404` as `permanent-not-found`
- fresh receipts with unrelated statuses or error codes as `fresh-write-unhandled`

Context routes own their recovery copy and actions. Shared code must not name business-specific resources such as checkout sessions, listings, payouts, or reviews. Checkout maps transient classifications to a temporary "preparing checkout" state with a refresh action, while stale or manual Checkout URLs keep the permanent not-found state. Non-Checkout detail routes should follow the same shape: Marketplace listing detail, Inventory import detail, Settlement payout detail, and Reputation review detail can map transient classifications to temporary resource-specific refresh states, but permanent `404` must remain a real not-found or access outcome.

Termination is bounded by token validity and retry budgets. Route loaders must not refresh indefinitely, regenerate `afterWrite` tokens without a new write, or treat expired/malformed tokens as retryable. Reloads, back/forward navigation, and delayed navigation may reuse the same token while it is still valid; once it expires, the route must fall back to permanent handling or explicit safe recovery copy. Repeated freshness timeouts and unmet semantic handoff expectations should keep the same temporary recovery only until the original token expires. Fresh-write routes must keep `readAfterWriteRouteInventory` metadata current and name exact `readFreshnessRoutes` dependencies whenever the destination reads projection-owned tables.

The token payload is intentionally limited to commit receipt metadata: observation time, source context names, source global positions, and event ids. It must not include account ids, email addresses, session ids, catalog item details, payment state, or other customer data. Server-side route fetches are responsible for forwarding the token as `Chase-Sets-Read-After-Write` plus the owning read target as `Chase-Sets-Read-Target-Context`; route and runtime tests should fail if either header is dropped.

## Idempotency

The runtime records projection application rows keyed by `(projection_key, event_id)`. A replay skips handlers already marked `applied`, which protects projection handlers when a worker restarts after handler success but before checkpoint persistence.

This ledger protects already-delivered events; it cannot recover an event that a checkpoint skipped before delivery. Gap-safe global ordering is therefore an event-store contract, not a projection-handler convention. DB coverage holds a lower uncommitted global position, commits a higher position from an independent transaction, and asserts that neither `readAll` nor subscription checkpoint fast-forward can advance until the lower transaction resolves.

Subscription handlers receive a transaction-scoped `db` handle in their handler context. New and migrated handlers should write read-model side effects through that handle so handler changes and the application ledger commit atomically. Existing one-argument handlers still run, but they are only conventionally idempotent until migrated to the transaction-aware path.

Handlers should still be written as deterministic upserts. Multi-step handlers that delete and reinsert rows should use a transaction-aware helper when available.

After a durable checkpoint advances, the runtime compacts `applied` ledger rows that are more than 10,000 global positions behind that checkpoint. Active `poison` and `transient` rows are retained for repair. Projection rebuild still clears all ledger rows for the rebuilt projection key.

## Poison Events

`strict-per-stream` remains the default projection error policy:

- The first poison event records a blocked stream.
- Later events on the same stream are deferred.
- Unrelated streams continue to drain.
- Retry replays the blocked stream from its first blocked version.
- Rebuild truncates the projection group's owned tables, clears checkpoints and application rows, and replays from origin.

## Ownership and Reset Strategies

Projections are consumer-owned bounded-context subscriptions: a context declares the facts it consumes, the projection group that owns the resulting read model, and the source contexts that feed it. Each owned table must appear in only one projection group per context. Shared outbox tables must either have one combined projection group owner or be explicitly partitioned by source/generation. Projection groups that own tables must declare a reset strategy: `replay-only`, `append-only-no-reset`, `truncate-owned-tables`, or `generation-cutover`. Event subscription groups that intentionally own no read-model table must be marked `sideEffectOnly: true`, keep `ownedTables: []`, and use `replay-only` so rebuild/replay behavior is explicit.

## Metrics To Watch

- Source lag by subscription.
- Active vs stale worker count.
- Runner `last_processed` and `updated_at`.
- Blocked stream count and oldest blocked age.
- Poison event count.
- Projection runner concurrency vs database saturation.
