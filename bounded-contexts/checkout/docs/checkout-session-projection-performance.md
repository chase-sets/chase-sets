# Checkout Session Projection Performance

This note captures the #1073 review and optimization for the guest Buy Now checkout freshness path.

## Critical Path

- Route: `GET /api/marketplace/account/checkout-sessions/:sessionId`.
- Read model: `checkout_session_pages`.
- Projection group: `checkout.session-projection`.
- Source event for guest Buy Now start: `checkout.session.started`.
- Freshness gate: exact `checkout_session_pages` dependency declared in Checkout `context.json`.

The route query reads by `session_id = $1 AND buyer_account_id = $2`. `session_id` is the table primary key, so the detail path is a single-row primary-key lookup with a buyer-account ownership filter. The buyer list path is supported separately by `checkout_session_pages_buyer_idx` on `(buyer_account_id, updated_at DESC, session_id DESC)`.

No additional index is required for the detail path. If query plans show a sequential scan in staging, treat that as a schema/bootstrap drift incident rather than adding a broader index.

## Optimization Applied

The session projection handlers now resolve the transaction-scoped projection database supplied by the platform runner before writing `checkout_session_pages`. This keeps the read-model write, subscription application ledger update, and completion marker inside the same projection transaction boundary.

The projection handler set is scoped to `checkout.session-` streams and checkpoints every applied session event. The event-type filter already limits the handler map to session lifecycle events; the stream-prefix filter keeps the subscription from scanning unrelated Checkout cart and Sell List streams, and the per-event checkpoint lets the read-after-write freshness gate observe the session event as soon as it is safely applied. The tradeoff is one checkpoint write per Checkout session event, which is acceptable for this buyer-facing critical path.

Checkout session command continuations no longer use `checkout_session_pages` to prove that a session exists before appending follow-up session events. They authorize against the event-store aggregate state, append the command event, and return a fresh aggregate-derived session snapshot. The confirmation route uses that returned snapshot after `SetShippingAddress`, `RecordOrdersCreated`, `RecordPaymentStarted`, and `RecordOfferSubmitted` instead of immediately rereading the projection inside the same request.

This removes avoidable command-side and intra-request read-model coupling. The initial checkout detail load still intentionally uses `checkout_session_pages` because the user-facing page is the read model covered by the exact read-after-write freshness gate.

## Local Evidence

The Checkout unit suite covers the optimized contracts:

- `features/sessions/read-model/projection.test.ts` proves the projection uses the transaction-scoped runner database instead of the base pool when context is supplied.
- `features/sessions/api/runtime.test.ts` proves the projection stays scoped to session streams with per-event checkpoints and that a just-created session can accept a shipping-option command while `checkout_session_pages` is unavailable.
- `features/sessions/api/route.test.ts` covers confirmation flows using fresh mutation results after write-side updates.

Local verification for this change:

- `pnpm --filter @chase-sets/checkout test`
- `pnpm exec tsc -p ./tsconfig.json --noEmit --pretty false`

## SLO Targets

The critical route keeps the platform freshness targets from `docs/architecture/projection-freshness-slos.md`:

- p95 <= 1,000 ms
- p99 <= 2,250 ms
- timeout rate <= 0.1%
- zero permanent not-found responses when a valid fresh `afterWrite` receipt is present
- zero exact-dependency fallback for audited critical Checkout canaries

This change makes the projection path cheaper and removes unnecessary read-model waits from command continuations. It does not by itself prove staging worker capacity. #1082 must validate worker topology and projection capacity, while #1074 and #1086 must provide end-to-end and synthetic staging evidence for the SLO.

## Remaining Bottleneck Ownership

- #1082 owns worker presence, replica count, restart behavior, projection concurrency, and commit-to-checkpoint lag.
- #1072 owns a targeted fast-path catch-up design if optimized projection plus capacity still cannot meet the freshness SLO.
- #1085 owns the final go/no-go review for fast-path catch-up after #1073, #1082, #1074, and #1086 evidence is available.
