# Post-Write Consistency Policy

## Purpose

Every Chase Sets mutation that changes user-visible state must choose an explicit post-write consistency strategy. This policy is the product-wide taxonomy that route authors, API owners, realtime consumers, and future structure checks reference before implementing a write flow.

This document does not replace the [Advanced Read-After-Write Route Author Checklist](./read-after-write-route-author-checklist.md), [Semantic Post-Write Handoffs](./semantic-post-write-handoffs.md), [Event Projection Runtime](./event-projection-runtime.md), [Projection Freshness SLOs](./projection-freshness-slos.md), or [Realtime SSE Runbook](../runbooks/realtime-sse.md). Those documents remain the detailed contracts for receipt propagation, semantic handoff metadata, projection waits, route inventories, SLOs, and SSE operation.

The consistency floor is durable domain state plus context-owned projections. Push wake signals, SSE, browser retries, and optimistic UI are latency and correction tools. They must never become the only correctness guarantee for critical immediate feedback unless a documented, tested fallback reads the authoritative projection again.

## Default-Safe Route Path

For projection-backed post-write navigation, the documented default is the shared helper pair:

1. Source actions call `navigateAfterWrite(commandResult, destinationRoute, options)`.
2. Destination loaders call `loadAfterWrite({ request, load, isNotFound, ... })`.
3. Routes map the returned `data`, `pending`, or `permanent-failure` result into a context-owned recovery boundary when available.

That pair is the default-safe path because it centralizes receipt encoding, semantic handoff pairing, bounded retry, fresh-write error classification, and low-cardinality telemetry. Route code should not hand-build `afterWrite`, parse `postWriteHandoff`, or duplicate retry classification unless it has a documented bespoke need.

Use the route-owned recovery boundary to keep temporary lag distinct from real blockers. The recovery boundary should accept canonical `PostWriteRecoveryKind` values from `loadAfterWrite`, render bounded preparing/retry copy for `pending-projection` or `refreshable-catching-up`, and render explicit restart/review/not-found/access recovery for `expired-handoff`, `action-required`, `stale-projection`, or `terminal-failure`. Checkout's readiness/source result split is the model: projection lag with a valid receipt is temporary; stale readiness, split-group handoff disagreement, auth, validation, domain blockers, and permanent not-found are not checkout preparation.

The manual [Read-After-Write Route Author Checklist](./read-after-write-route-author-checklist.md) is an advanced checklist for migrations, unusual helper composition, shared mounts, cookie-backed continuations, semantic predicates, or manifest exceptions. New ordinary routes should start with `navigateAfterWrite` and `loadAfterWrite`, then use the checklist only to verify the advanced details the helper path cannot infer.

## Strategy Taxonomy

| Strategy | Contract | Use When | Not Enough When |
| --- | --- | --- | --- |
| `fresh-read` | The write returns source-context commit receipt metadata; source routes use `navigateAfterWrite`; destination loaders use `loadAfterWrite`; server route clients forward `Chase-Sets-Read-After-Write`; the API waits on exact projection dependencies and either serves fresh data or returns bounded temporary recovery. Browser routes may also carry `postWriteHandoff` query metadata beside `afterWrite` when the destination must distinguish a stale `200` empty or stale resource shape from an actually empty/current result. | Critical redirects or reloads where stale state would look like lost money, a missing checkout session, a failed payment, a missing resource after a confirmed write, or a successful command hidden behind normal empty-state UI. | The destination read is not projection-backed, the flow stays on the same page and can safely use a returned snapshot, the route already has a durable job/status resource, or the user can tolerate explicit lag. |
| `optimistic-with-correction` | The client applies a local predicted state immediately, records the write in flight, then reconciles with the command result, a fresh refetch, or a bounded realtime correction. Failed writes roll back or show route-owned repair. | Quantity steppers, cart and sell-list controls, simple preference toggles, and other reversible account actions where immediate feel matters and failure can be explained inline. | The write starts checkout, creates payment/order side effects, changes money movement, or would hide authorization, inventory, quote, or fee failures. |
| `snapshot-return` | The command response includes the user-visible snapshot or version needed to render the committed state without waiting for a projection. The snapshot is scoped to the command owner and does not pretend downstream projections have caught up. | Same-context mutations where the aggregate can return a safe current view, such as a revised line quantity, selected option, fee quote, validation result, or command receipt. | Other route regions depend on downstream projections, cross-context read models, or server-derived totals that the command owner cannot authoritatively return. |
| `realtime-correction` | The initial page comes from a normal server/API read. SSE delivers durable projection patches or `sync.required`; clients patch only compatible visible state and refetch/reload on missed, expired, backpressured, invalid, or failed streams. | Multi-tab correction, account list refresh, public market updates, operator surfaces, and supplemental updates after a page is already usable. | Critical immediate feedback after a write unless paired with `fresh-read`, `snapshot-return`, or an explicit reload/refetch fallback that is tested. |

Use the smallest strategy that preserves trust. Combining strategies is expected: a quantity stepper may use `optimistic-with-correction` plus `snapshot-return`; checkout session start uses `fresh-read`; the checkout review page may also use `realtime-correction` to reload after later projection changes.

## Lag, Readiness, And Source Results

Projection lag means the committed source event has not reached the destination read model yet. It is temporary only when the request still has a valid fresh-write receipt or valid paired semantic handoff. Examples: a newly created listing detail returns `404` while `marketplace_listing_pages` catches up; an account cart add-line handoff loads a stale empty cart before `checkout_cart_line_pages` catches up; a checkout session read hits `projection_freshness_timeout` immediately after session creation.

Readiness and source results are domain facts, not projection lag. Examples: Checkout cart readiness is stale because the cart revision changed; split-group handoff evidence no longer matches the session; fulfillment is unresolved; payout setup is blocked; the actor lacks access; validation fails; the destination source resource truly does not exist. A fresh-write receipt must not convert those outcomes into "preparing" UI. Show the context-owned blocker, restart, review, or access recovery instead.

When both are possible, classify in this order:

1. If the route has a valid receipt and the only failure is missing/stale projection visibility, return bounded pending recovery.
2. If the API returns a domain/source/readiness blocker, render that blocker even when a receipt is present.
3. If the receipt is missing, malformed, expired, wrong-scope, or exhausted its retry budget, stop treating the state as temporary.

## Recovery Kind Taxonomy

Fresh-read and semantic handoff routes declare `transientRecovery` as an object with canonical `kinds` and route-owned `behavior` prose. `kinds` is one canonical recovery kind or an array of canonical kinds:

| Kind | Meaning |
| --- | --- |
| `pending-projection` | A valid semantic post-write handoff is not yet visible in an otherwise successful read response. |
| `refreshable-catching-up` | A valid fresh-write read hit a temporary `404`, `projection_freshness_timeout`, or bounded gateway/service timeout and can retry or revalidate. |
| `stale-projection` | The route can identify a stale projection shape that should not be presented as final. |
| `action-required` | The route has left the bounded temporary state and needs a user retry, reload, restart, or similar explicit recovery action. |
| `expired-handoff` | The semantic handoff or fresh-write receipt expired before the expected state became visible. |
| `terminal-failure` | The token, handoff, authorization, or destination state is malformed, missing, wrong-scope, or otherwise not recoverable as temporary lag. |

## Flow Class Rules

| Flow Class | Default Strategy | Allowed Additions | Required User Outcome |
| --- | --- | --- | --- |
| Critical Checkout | `fresh-read` for session start, pay-ready handoff, payment detail, and any redirect to projection-backed checkout/payment state. | `snapshot-return` for same-route validation or selected edit results; `realtime-correction` only as supplemental reload after the page has a safe baseline. | The buyer reaches the intended page, a payable review state, or temporary preparing/recovery while the original receipt is fresh. Expired handoffs must use safe restart copy and confirm payment has not started when applicable. |
| Account Self-Refresh | `optimistic-with-correction` or `snapshot-return` for reversible edits; `fresh-read` when redirecting to a projection-backed detail page. | `realtime-correction` for open account lists, multi-tab updates, and stale-patch recovery. | The account sees either the expected updated state, an inline rollback/error, or a bounded refresh/reload prompt. No indefinite spinners or hidden stale data. |
| Operator/Admin | `snapshot-return` or `realtime-correction` with explicit freshness, lag, partial, or unavailable states. Use `fresh-read` only for operator writes that immediately navigate to projection-backed detail. | Durable job SSE, projection operation SSE, and realtime reload prompts. | Operators can distinguish fresh, stale, lagging, partial, and unavailable data, and have an explicit retry/reload or diagnostic path. |
| Background Flows | No browser immediacy requirement. Durable jobs, projections, scheduled reconciliation, and outbox processing own convergence. | SSE or notification updates can expose progress, but must replay from durable rows or return `sync.required`. | The system converges through durable queues/projections; missed wake signals cost latency only. User-visible surfaces show status or refresh from projections. |

## Cross-Context Fresh-Write Fallbacks

Cross-context fallback is allowed only when it is explicit, guarded, observable, and removable. A fallback must not become the normal read model for another bounded context. Prefer event projection and exact freshness waits first; use one of these categories only when a bounded fresh write can otherwise hide a committed fact while the destination projection catches up.

| Category | Allowed Shape | Required Guards | Termination |
| --- | --- | --- | --- |
| Host-owned bridge | A deployable or worker composition root wires a narrow provider-owned server surface into the consuming context for request-time recovery while the consumer's own projection catches up. | Provider surface is explicit in `allowedContextDependencies` or host ports; response is limited to the fields the consumer already projects; no direct cross-context SQL; actor or system ownership is established by the host call site. | Consumer projection wins whenever present. Fallback runs only on projection miss or bounded recovery branch and must be removable after catch-up hardening. |
| Same-actor post-write recovery | A source route carries a receipt for a write the same actor just performed, and the destination reads the provider-owned projection or API only while that receipt is valid. | Valid fresh-write receipt; actor/account scope matches the original write; destination owns user-visible recovery copy; catalog/source guard names the exact source fact being recovered. | Stop on token expiry, retry budget exhaustion, wrong actor/source, or permanent provider failure. |
| Synchronous projection | The source command or host waits for the destination projection group to reach the exact source position before returning or navigating. | Exact projection dependency; bounded wait budget; observability for wait outcome and timeout; no unrelated target-context fallback. | Stop after the exact projection reaches the source position or the bounded wait returns a retryable/temporary result. |
| Forbidden shortcut | Directly reading another context's database, reusing another context's internal integration surface, or treating another context's stale projection as authority without a receipt or projection wait. | Not allowed. | Remove or replace with one of the allowed categories. |

Every declared fallback must name the actor/ownership guard, catalog/source guard where applicable, freshness scope, projection waited on, termination rule, and observability guidance. Existing fallback declarations belong in the owning context manifest until `check:structure` gains a dedicated cross-context fallback inventory; that future guard should validate the category, source and target contexts, projection group/table, allowed dependency or host port, proof tests, and termination rule.

Current audited fallbacks:

| Fallback | Category | Freshness Scope | Projection Waited On | Termination / Observability |
| --- | --- | --- | --- | --- |
| Commercial Terms account-source resolution | Host-owned bridge | Commercial Terms resolution for a specific account after a fresh Identity account creation or profile state change. | `commercial-terms-account-projection` into `commercial_terms_account_pages`, sourced from Identity account events. | `commercial_terms_account_pages` wins whenever present; the Identity account source is invoked only on projection miss, returns only account id/type/status, and fails closed when Identity has no account, account type, or active status. Runtime records `post-write.consistency` outcomes `projection_hit`, `fallback_used`, and `fallback_failed` with context/projection/fallback labels only. See `bounded-contexts/commercial-terms/context.json` `crossContextFallbackInventory`. |
| Discovery selected seller listing recovery | Same-actor post-write recovery | Discovery item detail can recover a selected seller listing immediately after a same-actor Marketplace listing publish or update while the Discovery market projection catches up for that listing. | `discovery-market-projection` into `discovery_market_listings`, sourced from Marketplace listing events. | The Discovery projection wins whenever the selected listing is already present. The fallback requires a valid Marketplace listing handoff, sell-market selected listing id, listing view/manage permissions, same actor ownership, matching catalog item, and supported seller listing status; it stops on missing/expired/malformed/non-Marketplace receipts, missing handoff, wrong actor/catalog, missing permissions, permanent Marketplace failure, or bounded retry exhaustion. See `bounded-contexts/discovery/context.json` `crossContextFallbackInventory`. |
| Inventory listing-stock storage-location setup | Synchronous projection | Inventory listing-stock creation can create the account's default listing-stock storage location and immediately update Inventory's own storage-location read model so the same command can continue without a cross-context read. | Inventory-owned `inventory_storage_locations`; the browser list route still declares `inventory-storage-location-projection` freshness in `bounded-contexts/inventory/context.json`. | This is a documented same-context exception, not a `crossContextFallbackInventory` entry. It must remain scoped to Inventory-owned storage-location state, and storage-location browser redirects still use `afterWrite`/fresh-read recovery instead of treating the compatibility write as a general read path. Evidence lives in `bounded-contexts/inventory/features/inventory-items/api/runtime.test.ts` and `bounded-contexts/inventory/tests/account-inventory-routes.test.ts`. |

## Concrete Flow Guidance

Critical Checkout examples:

- Guest Buy Now session start is `fresh-read`: the action appends `afterWrite`, the destination loader uses exact `checkout_session_pages` freshness, and temporary recovery is allowed only while the original token is valid.
- Checkout session edits that stay on the review page may use `snapshot-return` for command-local validation or edit-section state. If an edit depends on recalculated read models, the page must refetch or reload rather than relying only on SSE.
- Checkout realtime subscriptions are `realtime-correction` only after the loader has established a safe session baseline. Their `onPatch` and `onSyncRequired` behavior must reload/refetch; they are not the guarantee that session creation or pay readiness succeeded.

Account self-refresh examples:

- Quantity steppers are `optimistic-with-correction`: update the visible quantity immediately, disable or serialize conflicting writes as needed, reconcile with the command response or refetch, and roll back with inline copy when the write fails.
- Cart and sell-list mutations may use `snapshot-return` when the command can return the visible row, total, and version it owns. If a cross-route account cart or list handoff can be hidden by a stale `200` empty collection after a successful add, use a semantic `postWriteHandoff` with `fresh-read` so the destination can show pending recovery only for that add-line expectation. If marketplace, inventory, fee, fulfillment, or payment projections are needed, the route must refetch those surfaces explicitly.
- Listing create-to-detail and payment create-to-detail are `fresh-read` because the user navigates to a projection-backed resource that could otherwise look missing.
- Marketplace account listings, account offers, and offer matches use realtime as a correction channel for already loaded lists. Their `onSyncRequired` fallback must reload the server route.

Non-Checkout product flows:

- Discovery item, listing, public-account, and search pages use realtime patches as supplemental market correction after the initial server read. A missed stream, cursor expiry, or replay backpressure must become route reload/refetch, not silent staleness.
- Catalog admin list surfaces use realtime invalidation either to auto revalidate or to prompt an explicit reload. They remain operator/admin flows because the page can represent freshness and reload state.
- Durable job progress SSE is not a projection freshness guarantee. It is a resumable progress transport backed by durable job event rows; stale replay coalesces to `sync.required` and clients refresh the job snapshot.
- Catalog/admin imports, projection operations, export jobs, and other durable job/status flows should stay job/status driven. Do not add browser `postWriteHandoff` metadata merely because a command enqueues work; use it only when a successful command can be hidden by an immediate stale `200` empty, stale unchanged resource, or `404`.

## Realtime/SSE Correction Channel Rules

Realtime/SSE is bounded correction, not source-of-truth execution:

- Publish client-facing `projection.patch` messages only; never stream raw domain events.
- Patch only a route's already loaded, compatible visible shape. If a patch cannot be applied safely, trigger reload/refetch.
- Treat `sync.required` as mandatory reload/refetch. Valid reasons are cursor expiry and replay backpressure.
- Treat missed notifications, `LISTEN` unavailability, deploy drain, stream errors, connection limits, and backoff as latency events. Durable outbox replay or route reload must recover.
- Keep topic ownership in the bounded context that owns the projection/read model. Public topics can expose public market facts; account topics require actor/account authorization.
- Realtime-only is disallowed for critical immediate-feedback mutations unless the route documents and tests a fallback that re-reads authoritative state within a bounded budget.

Realtime can shorten visible lag and correct already loaded pages, but it does not guarantee that the first read after a write is fresh. A missed stream, delayed patch, cursor expiry, or deploy drain must fall back to route reload/refetch or the `loadAfterWrite` recovery boundary; it must not promise that a committed write is visible.

Existing realtime consumers are classified as:

| Surface | Current Role | Required Fallback |
| --- | --- | --- |
| Checkout session preview topics | Supplemental correction after fresh loader state. | Reload/refetch on patch or `sync.required`; session start and pay readiness stay governed by `fresh-read`. |
| Marketplace account listings, submitted offers, and offer matches | Primary correction for an already loaded account list; not initial write guarantee. | `onSyncRequired` reloads the route; patch logic must not insert incompatible rows into paged data. |
| Discovery search, item detail, public listing, and public account | Supplemental public market correction. | Reload/refetch when cursor expiry, replay backpressure, malformed messages, or unsupported patch shapes occur. |
| Catalog admin catalog items and admin surfaces | Operator/admin invalidation and reload prompt. | Auto revalidate or prompt an explicit reload on patch or `sync.required`. |
| Durable job and projection operation SSE | Progress/status transport. | Replay from durable event rows; coalesce stale replay to a snapshot or `sync.required`. |

## Termination And Recovery

Termination must be visible, bounded, and tied to the original write.

- `afterWrite` expiry is final. Missing, malformed, far-future, expired, or wrong-actor tokens must not be refreshed, re-minted, or treated as temporary.
- Retry/reload budgets belong to the route. A fresh token can retry `404`, `projection_freshness_timeout`, or a route-bounded opaque gateway/service timeout only until the token expires or the route's attempt budget is exhausted.
- Do not show a spinner, disabled control, or "preparing" state past the retry budget. Once the budget ends, render the route-owned action-required, expired-handoff, stale-projection, or terminal recovery.
- Realtime reconnects must use the last cursor where available, back off after noisy errors, and close streams on unmount. Cursor expiry or replay backpressure terminates patch replay and requires a full reload/refetch.
- Optimistic UI must either confirm, reconcile, or roll back. A failed write must restore the last known server state or replace the optimistic state with a server-returned snapshot plus inline recovery copy.
- Snapshot responses must include enough version/status information for the client to detect stale command results, concurrent edits, or quote/fingerprint drift. Stale snapshots must not overwrite newer local or server-confirmed state.
- Background and operator flows must expose stale, lagging, partial, unavailable, or retryable status instead of silently presenting old projections as current.

User-visible recovery should name the user task, not the infrastructure. "Preparing checkout", "Reload listings", or "Quantity could not be updated" is appropriate. "Projection timeout" belongs in logs, metrics, and operator diagnostics, not customer-facing copy.

## Migrating An Existing Route

Use this section as the canonical link target for per-context migration issues.

1. Classify the mutation in `mutationConsistencyInventory`; use `fresh-read` only when an immediate projection-backed read can hide the committed write.
2. Replace manual URL construction with `navigateAfterWrite`; pass a semantic `handoff` option only when a stale successful response can hide the expected outcome.
3. Replace bespoke loader retry code with `loadAfterWrite`; keep unrelated secondary reads on a non-fresh request when they should not inherit the write receipt.
4. Wire the route's recovery boundary to the helper result: `data` renders normally, `pending` renders bounded preparing/retry copy, and `permanent-failure` preserves not-found/access/domain recovery.
5. Declare exact `readFreshnessRoutes` dependencies with `readModelTable` whenever the table has one projection owner; use `projectionName` only for multi-table or projection-level waits and document the reason.
6. Update `readAfterWriteRouteInventory` with helper uses, dependency proof, transient recovery kinds, and semantic handoff evidence if used.
7. Add focused tests for source navigation, destination loading, fresh temporary recovery, expired/malformed permanent recovery, and domain/readiness blockers not being treated as lag.

Non-goals stay unchanged during migration: do not add synchronous projection drains, do not spin past the route retry budget, and do not treat realtime correction as the guarantee that the first post-write read is fresh.

## Stale Response And Rollback Behavior

For `fresh-read`:

- Fresh receipt plus `404` or `projection_freshness_timeout` is temporary only while the receipt is valid.
- Fresh receipt plus unrelated `401`, `403`, validation, conflict, or domain errors is not projection lag.
- Expired checkout handoffs use safe restart copy; expired non-checkout detail routes return normal not-found/access behavior or context-owned recovery.

For `optimistic-with-correction`:

- Queue or supersede rapid writes explicitly. Last-click-wins is acceptable only when the server command is idempotent or versioned enough to reject stale writes.
- On validation, conflict, authorization, inventory, fee, or quote failure, roll back the optimistic value or replace it with the server snapshot and show the route-owned recovery.
- Do not keep a disabled control or spinner past the retry budget. Restore actionability with clear status.

For `snapshot-return`:

- Apply the snapshot only when its aggregate id, actor/account scope, command id or version, and route context match the current view.
- If a later user action has already advanced the local version, ignore older snapshots and refetch if needed.
- Never infer downstream projection freshness from a command snapshot unless the response explicitly owns that visible shape.

For `realtime-correction`:

- Ignore malformed, unauthorized, unrelated-topic, wrong-projection, or incompatible patch messages.
- `remove` and `summary` patches may update or remove visible rows; paged lists must not insert rows that were not already in the server-loaded page unless the route contract explicitly supports that insertion.
- On `sync.required`, missed retention, excessive lag, stream limit rejection, or repeated stream errors, reload/refetch from the API.

## Required Tests And Evidence

Each mutation strategy must name evidence in the owning context or platform package.

| Strategy | Required Evidence |
| --- | --- |
| `fresh-read` | Source action test for commit receipt and `afterWrite`; route/client test that forwards `Chase-Sets-Read-After-Write` and `Chase-Sets-Read-Target-Context`; manifest coverage in `readFreshnessRoutes` and `readAfterWriteRouteInventory`; transient recovery tests for fresh `404`, `projection_freshness_timeout`, bounded gateway timeout, and valid unmet `postWriteHandoff` when used; permanent recovery tests for missing/expired/malformed/wrong-actor token; SLO/canary evidence for critical checkout. |
| `optimistic-with-correction` | UI or route tests for optimistic apply, in-flight sequencing, server success reconciliation, validation/conflict rollback, network failure recovery, stale response suppression, and accessible inline status. Include rapid-click or concurrent edit coverage for quantity steppers and cart/sell-list controls. |
| `snapshot-return` | API/command tests proving the returned snapshot is scoped, versioned, and reflects the committed aggregate; client tests proving stale snapshots do not overwrite newer state; contract tests for stale quote/fingerprint responses when money, fee, fulfillment, or availability data can drift. |
| `realtime-correction` | Contract tests for `projection.patch` and `sync.required`; topic authorization/redaction tests; durable outbox replay and retention expiry tests; route/client tests that apply compatible patches and reload/refetch on `sync.required`; stream failure/backoff/close tests; patch ordering or stale patch tests where the route mutates paged/list state. |

Existing evidence includes `infrastructure/platform-runtime/realtime-routes.test.ts`, `infrastructure/platform-runtime/realtime-web.test.ts`, `infrastructure/platform-runtime/realtime-outbox.test.ts`, `infrastructure/platform-runtime/realtime.db.test.ts`, `contracts/realtime/index.test.ts`, `bounded-contexts/catalog/support/shell-support/ui/realtime-revalidation.test.tsx`, `bounded-contexts/marketplace/tests/realtime-patches.test.ts`, and `bounded-contexts/discovery/tests/realtime-market.test.ts`.

Local verification for policy or structure changes should normally include:

```powershell
pnpm run check:structure
pnpm run test:structure
pnpm --filter @chase-sets/realtime run test
pnpm --filter @chase-sets/platform-runtime run test -- realtime-routes.test.ts realtime-web.test.ts realtime-outbox.test.ts
```

Run broader context tests when touching route code, UI behavior, command handlers, or manifests. With Postgres available, include the realtime DB integration test named in the [Realtime SSE Runbook](../runbooks/realtime-sse.md).

## Audit Telemetry

Post-write flows should emit low-cardinality audit events when they choose, apply, correct, or terminate a consistency strategy. The shared metric is `chase_sets_post_write_consistency_events_total` with `type="post-write.consistency"` and bounded labels for context, surface, strategy, outcome, route id, route template, correction source, actor mode, recovery action, and freshness outcome.

Canonical outcomes are:

| Outcome | Meaning |
| --- | --- |
| `missing_strategy` | A mutation reached a user-visible post-write path without an inventory-backed strategy. |
| `optimistic_applied` | The route applied a bounded optimistic state after a reversible write. |
| `freshness_timeout` | A fresh-read path exhausted its bounded projection wait or route budget. |
| `rollback` | The route restored or replaced optimistic state after a failed or rejected write. |
| `reconciliation` | Server-confirmed state reconciled the local view after a write. |
| `stale_response_discard` | An older command, snapshot, refetch, or patch was ignored because newer local/server state already won. |

Labels must never contain account ids, cart ids, checkout session ids, item ids, event ids, raw `afterWrite`, cookies, emails, full URLs, or provider payloads. Use route templates such as `/account/cart` and stable surface names such as `account-cart`.

Account cart release evidence uses the [Account Cart Consistency Probe](../runbooks/account-cart-consistency-probe.md). The probe is a redacted observation artifact until the Marketplace/runtime owner adds fixture-owned browser automation with cleanup.

## Privacy And Redaction

Post-write consistency metadata must stay structural:

- `afterWrite` and commit receipts may contain observation time, source context names, source global positions, and event ids only.
- Do not include account ids, user ids, emails, contact names, session ids, checkout session ids, payment identifiers, order identifiers, item details, catalog payloads, payment state, cookies, bearer tokens, or guest tokens in `afterWrite`.
- Logs, metrics, dashboards, canary output, and freshness audit rows must use route templates, context names, projection names, dependency names, outcome codes, durations, and sanitized error categories.
- Realtime topic values may include account identifiers only as routing keys after topic-policy authorization. They must not include emails, payment identifiers, checkout session tokens, cookies, provider credentials, or payment data.
- SSE patch payloads must contain only client-facing projection facts already allowed on the subscribed route. Raw domain event payloads, worker-private durable job payloads, and provider response bodies must not be streamed.
- Cursor ids are opaque. Do not log decoded cursors or signing material; status snapshots may report whether signing is configured, not the keys.

When privacy and freshness conflict, privacy wins. The recovery path should reload an authorized route or show safe recovery copy rather than expanding tokens, topics, logs, or patch payloads with sensitive data.

## Enforcement Guidance

`pnpm run check:structure` generates `artifacts/read-after-write-route-inventory.md`, which is the product-wide post-write consistency inventory. The report includes fresh-write route metadata, discovered mutation surfaces, and an audit summary grouped by bounded context and failure class so #1809 can split current gaps into bounded remediation issues.

The mutation scanner discovers browser route actions, statically identifiable POST forms and fetcher submits, mutating Hono API routes, mutating API-client calls, and existing fresh-write helper usage. New surfaces must be classified in the owning context's `mutationConsistencyInventory` or the structure check fails. Existing unclassified surfaces are staged in `scripts/check-structure/mutation-consistency-baseline.json` as migration rows linked to #1809; removing a surface from code without removing its baseline row also fails so audit debt cannot disappear silently.

`mutationConsistencyInventory` entries record the selected strategy as one of `fresh-read`, `optimistic-with-correction`, `snapshot-return`, or `realtime-correction`, plus narrow non-failure/migration classifications when a mutation is not immediately user-visible or is still being audited. Semantic `postWriteHandoff` is recorded as `fresh-read`, not as a separate strategy. `fresh-read` entries must name exact API freshness dependencies and transient recovery, including any route-owned pending state for a valid but unmet semantic handoff. `optimistic-with-correction`, `snapshot-return`, and `realtime-correction` entries must name their strategy-specific proof fields and tests. Realtime may be recorded only when the route also names its reload/refetch fallback, topic policy owner, patch contract, and tests for `sync.required` or missed-patch recovery.

Critical flows must fail enforcement when they rely on `realtime-correction` alone. They need `fresh-read`, a command-owned `snapshot-return`, or a documented fallback that performs a fresh authoritative read inside a bounded customer-visible budget.
