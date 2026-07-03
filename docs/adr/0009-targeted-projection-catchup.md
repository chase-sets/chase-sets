# 0009 Targeted Projection Catchup

## Status

Accepted

## Context

Milestone #16 investigated a guest Buy Now checkout failure where a browser reached `/checkout/:sessionId` before `checkout_session_pages` had caught up. The customer saw permanent checkout-session-not-found recovery even though the session appeared later.

The platform now has the baseline protections that were missing from that failure path:

- write responses propagate short-lived read-after-write receipts;
- shared API mounts can wait on exact read-model dependencies declared by context manifests;
- critical routes classify fresh-write `404` and `projection_freshness_timeout` as temporary recovery states;
- `checkout.session-projection` is scoped to `checkout.session-` streams and checkpoints every applied session event;
- Checkout session command continuations authorize against aggregate state instead of depending on a lagging `checkout_session_pages` row;
- worker-owned projection groups run under platform control-plane leases and fencing tokens;
- operator repair operations already use the same lease model for rebuild and blocked-stream retry.

The remaining question was whether a critical read should actively run or wake the exact required projection before polling checkpoints.

## Decision

Do not add route-time fast-path projection catchup to the customer read path for this milestone.

The accepted platform contract remains:

1. command writes return durable commit receipt metadata;
2. browser redirects use `navigateAfterWrite` to carry the receipt and optional semantic handoff;
3. destination loaders use `loadAfterWrite`, and server route fetches forward the receipt and target context;
4. read consistency middleware waits on exact projection dependencies declared by the owning context, preferring `readModelTable` ownership when available;
5. route recovery boundaries render temporary recovery only while a fresh receipt is still valid and the failure is projection visibility rather than readiness/source disagreement;
6. projection workers drain owned projection groups under leases, fencing, idempotent application ledger claims, statement timeouts, and poison-event isolation;
7. operators use projection operations for repair work such as rebuild and blocked-stream retry.

#1072 should close as not planned after this ADR lands. A future fast-path proposal must reopen with new measured evidence that the baseline path cannot meet the Checkout freshness SLO after worker topology, canary, and E2E evidence are complete.

## Rejected Options

### Inline Catchup Inside The Read Request

Running projection handlers directly from `GET /account/checkout-sessions/:sessionId` would make a customer request compete with worker projection ownership. To make it safe, the route would need to acquire the projection-group lease, preserve fencing tokens, apply the subscription application ledger, respect poison blocked-stream semantics, enforce statement timeouts, and avoid duplicating worker work. That duplicates the worker runtime inside the API request path and can turn projection backlog into user-facing request latency.

Rejected unless future evidence shows all worker-owned paths cannot satisfy the SLO and a separately designed implementation proves it can preserve every worker guarantee.

### Worker Wake Or Signal Before Polling

A narrow wake signal is safer than inline catchup, but the current runtime does not expose a "catch this projection up to this receipt position" operation. Existing projection operations are asynchronous operator actions for rebuild and blocked-stream retry, not customer-read accelerators. A wake path would still need rate limits, duplicate suppression, per-projection eligibility, a kill switch, and observability proving it improves latency without increasing lease contention.

Rejected for this milestone because the baseline path has not failed its SLO after the #1073 optimization and #1082/#1074/#1086 evidence is still the proper proof path.

### Bounded Polling With Exact Dependencies

This is the chosen approach. It keeps read consistency narrow, observable, and rollback-safe while leaving projection execution in the worker runtime. Customer trust is protected by temporary recovery rather than permanent stale not-found. Operators can tune timeout and poll interval per route, fall back from exact dependency mode to target-context mode during rollback, and inspect projection status or poison events when the SLO fails.

## Reopening Criteria

Create a new design issue before implementing any fast-path catchup if all of the following become true:

- #1082 proves worker topology and capacity are healthy enough that lag is not simply an undersized or absent worker problem;
- #1074 and #1086 reproduce repeated `projection_freshness_timeout` or repeated temporary checkout states after the #1073 optimization;
- the `checkout.session-start-to-detail` SLO fails with exact dependencies enabled and without target-context fallback;
- no permanent not-found is present, because permanent not-found remains a route/API recovery bug rather than a catchup justification;
- the proposed design includes an independent kill switch, per-route and per-projection eligibility, rate limits, duplicate suppression, lease/fencing preservation, statement timeouts, poison/degraded handling, audit metrics, and rollback evidence.

## Consequences

- #1085 is satisfied by an explicit no-go decision for this milestone.
- ADR 0010 supersedes only the no-go on worker wake signals; it does not change this ADR's rejection of inline route-time projection catchup.
- #1072 is not required for milestone closure and should be closed as not planned.
- #1082, #1074, #1075, and #1086 remain the right closure path for proving the baseline contract in staging and production evidence.
- Future work must not add a route-time projection runner or hidden synchronous drain without a new accepted ADR or design record.
- Default-safe post-write route helpers do not change the no-go decision. They standardize receipt propagation, bounded retry, and recovery classification; they do not synchronously drain projections or make realtime correction a first-read guarantee.
