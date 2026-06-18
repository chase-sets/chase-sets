# Semantic Post-Write Handoffs

## Purpose

A semantic post-write handoff is optional browser-route metadata that tells the destination what visible outcome the user just asked for. It is for `fresh-read` flows where the API can return a technically successful but semantically stale response, such as `200` with an empty collection after adding the first cart line, or `404` while a newly created detail page projection is still catching up.

It does not replace `afterWrite`, `readFreshnessRoutes`, `readAfterWriteRouteInventory`, or `mutationConsistencyInventory`. It rides beside `afterWrite` as `postWriteHandoff` query metadata, and it is valid only while the paired `afterWrite` receipt is valid.

## Contract

- Source routes use `appendPostWriteHandoff` or `appendPostWriteHandoffFromSources` instead of a plain fresh-write append when the destination needs semantic recovery.
- The resulting browser URL carries both `afterWrite` and `postWriteHandoff`.
- Production routes must not hand-build the `postWriteHandoff` query value. Contexts may export semantic constants and destination predicates, but URL construction stays in the shared `@chase-sets/http` helpers so expiry, redaction, and receipt pairing stay consistent.
- Server-side API fetches still forward only freshness receipt metadata through `Chase-Sets-Read-After-Write` and `Chase-Sets-Read-Target-Context`.
- Destination routes use `readPostWriteHandoffState`, `readPostWriteHandoff`, or `evaluatePostWriteHandoff` against the browser request and the loaded data.
- A valid handoff can make a stale `200` empty, stale `404`, or not-yet-updated resource state temporary. Missing, malformed, expired, or unpaired handoffs are not applicable and must fall back to normal route behavior.

Safe handoff metadata is intentionally tiny:

```json
{
  "kind": "checkout.cart.add-line",
  "expectation": "collection-non-empty",
  "surface": "account-cart"
}
```

Supported expectations are `resource-present`, `resource-updated`, `resource-absent`, and `collection-non-empty`. `kind` and `surface` must be stable structural labels. Do not include account ids, user ids, resource ids, cart ids, checkout session ids, emails, cookies, event ids, raw receipts, full URLs, item details, payment state, provider payloads, or arbitrary JSON.

## When To Use It

Use semantic handoffs only when all of these are true:

- A command has committed successfully.
- The user is sent to, or invited to open, a browser route that immediately reads projection-backed state.
- A stale read could hide the successful command behind a normal-looking `200` empty state, stale unchanged resource, or `404`.
- The destination can locally evaluate whether the expected outcome is visible.
- The route has bounded temporary recovery copy and a retry/reload budget.

Do not force semantic browser handoffs onto durable job, operation, or status flows. Catalog/admin imports, projection operations, export jobs, and similar long-running work should return or link to a durable job/status resource, then use status polling, SSE, or snapshot refresh backed by durable rows. For those flows, classify the mutation in `mutationConsistencyInventory` as `snapshot-return`, `realtime-correction`, or the appropriate non-immediate strategy instead of manufacturing browser `afterWrite` recovery.

## Inventory And Audit

Semantic handoffs are part of the existing `fresh-read` strategy. They are not a fifth post-write strategy.

- Keep the write surface classified in `mutationConsistencyInventory` as `fresh-read` when semantic pending recovery protects the immediate read.
- Keep exact API dependencies in `apiMounts[].readFreshnessRoutes`; semantic metadata does not broaden the projection wait.
- Record helper uses in `readAfterWriteRouteInventory`: source helpers such as `appendPostWriteHandoff`, destination helpers such as `evaluatePostWriteHandoff`, and route-owned `transientRecovery` that names both projection-lag and unmet-semantic-expectation behavior.
- Use an exception only when the helper is not the owner of the post-write read, using the same owner, reason, and `reviewBy` rules as other fresh-write helper exceptions.

Marketplace and admin audits should migrate only flows where stale reads can hide a successful command. An empty account cart after add-line, a listing detail `404` after publish, or a stale account detail after create/update are candidates. Durable job/status pages, operator work queues with explicit lag states, and command responses that already return the visible committed snapshot are not candidates by default.

The current migration inventory lives in [Semantic Post-Write Handoff Audit](./semantic-post-write-handoff-audit.md). Update it before adding new cross-platform handoff kinds.

## Observability

Semantic handoff diagnostics compose with the existing post-write consistency telemetry. Do not add a new metric family unless the existing one cannot express the outcome.

Use `chase_sets_post_write_consistency_events_total` with:

- `type="post-write.consistency"`
- `strategy="fresh-read"`
- `surface` and `route_id` as stable structural labels
- `route_template` as a route template, not a concrete URL
- `correction_source="semantic-handoff:<kind>"`
- `freshness_outcome` as a low-cardinality receipt state such as `valid-after-write`, `expired-after-write`, `malformed-after-write`, `missing-after-write`, or `not-applicable`

Supported semantic outcomes are `handoff_parsed`, `handoff_satisfied`, `handoff_pending`, `handoff_expired`, `handoff_invalid`, `handoff_malformed`, and `handoff_permanent`. Route authors may record only the final route decision when double-counting would be noisy; critical flows should at least emit pending and permanent outcomes.

Metric labels and logs must never include raw `afterWrite`, raw `postWriteHandoff`, account ids, cart ids, listing ids, checkout session ids, payment ids, order ids, emails, cookies, event ids, item details, provider payloads, or full URLs. Operators should be able to distinguish projection lag from route wiring bugs by comparing semantic handoff outcomes with `read-after-write.freshness` audit outcomes for the same route template and context.

Bounded contexts emit post-write consistency diagnostics through the platform-runtime post-write telemetry port. Deployables that own observability, such as Marketplace Web, register the adapter that calls `@chase-sets/observability`. Do not import the observability package directly into a bounded context route just to record semantic handoff outcomes.
