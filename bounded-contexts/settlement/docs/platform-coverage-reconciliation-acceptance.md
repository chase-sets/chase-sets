# Platform-Funded Resolution Reconciliation — Operator Acceptance Packet

This packet is the Wave 3 go-live evidence for platform-funded and split support
resolutions (ADR 0022, epic #5210; reverse-logistics epic #5211). It proves the
workflow is launch-ready as an end-to-end reconciliation — not merely because each
context passes its own unit tests — and records the reconciliation signals, rollout
controls, SLOs, escalation ownership, and the operator sign-off gate.

Financial truth stays Settlement-owned (ADR 0013/0020, reaffirmed by ADR 0022). The
proof is composed, not duplicated: Settlement proves the money invariants, Support
proves the case-closure gate, and Payments/Fulfillment evidence is cross-linked rather
than re-run here (#3733, #571, #596, #572).

## Golden assertion

A fully platform-covered case refunds the buyer exactly once, never debits the seller,
consumes exactly the reserved protection amount exactly once, and cannot close until
every required financial and physical effect reconciles. This is proven at the event and
ledger-decision levels by the two automated proofs below.

## Acceptance matrix

| ID | Journey | Scenario type | Reconciliation invariant proven | Verification evidence |
| --- | --- | --- | --- | --- |
| J1 | Fully platform-funded, no return, immediate refund | happy path | Reserve → refund → settle once; zero seller debit | `platform-coverage-reconciliation-proof.test.ts` |
| J2 | Platform-funded, return-to-platform, refund on carrier acceptance | happy path | Trigger timing is Support-side; settlement decision identical | `platform-coverage-reconciliation-proof.test.ts`, `platform-coverage-remedy-lifecycle-proof.test.ts` |
| J3 | Platform-funded, return-to-platform, refund after facility intake | happy path | Same financial reconciliation as immediate | `platform-coverage-reconciliation-proof.test.ts` |
| J4 | Split-funded remedy with exact seller/platform postings | happy path | Exact seller debit + exact platform settle; penny-perfect split | `platform-coverage-reconciliation-proof.test.ts` |
| J5 | Seller-funded regression path | happy path | Seller debited in full; no reserve consumed; legacy default preserved | `platform-coverage-reconciliation-proof.test.ts` |
| J6 | Coverage rejected for insufficient availability / policy | failure | Case stays open; no seller debit; closed rejection reason | `platform-coverage-reconciliation-proof.test.ts` |
| J7 | Reservation expires before refund | failure | Late refund quarantines; funds returned; seller untouched | `platform-coverage-reconciliation-proof.test.ts` |
| J8 | Refund provider accepts but response lost; webhook later confirms | recovery | Reserve consumed exactly once under redelivery | `platform-coverage-reconciliation-proof.test.ts` |
| J9 | Duplicate and out-of-order Support/Payments/Settlement facts | recovery | Duplicate delivery is a decide-layer no-op; rebuild converges | `platform-coverage-reconciliation-proof.test.ts`, `platform-coverage-remedy-lifecycle-proof.test.ts` |
| J10 | Carrier exception / lost return with operator resolution | destructive recovery | Operator releases the reserve; no seller debit | `platform-coverage-reconciliation-proof.test.ts` |
| J11 | Refund succeeds while Settlement reconciliation temporarily unavailable | recovery | Re-run is deterministic on the same inputs | `platform-coverage-reconciliation-proof.test.ts` |
| J12 | Incorrect legacy seller debit repaired through the approved correction path | destructive recovery | Corrected allocation posts zero new seller debit; reserve consumed | `platform-coverage-reconciliation-proof.test.ts` |
| J13 | Golden closure gate: no case complete while an effect is pending | audit | Case cannot close until coverage, refund, and settlement effects all satisfy | `platform-coverage-remedy-lifecycle-proof.test.ts` |

### Known pending seam

The `carrier-accepted` and `return-delivered` auto-triggers (fulfillment reverse-tracking
scan → remedy effect) are not yet wired end to end; `facility-intake` and
`operator-release` are (#5229/#5479). J2/J13 assert against the stable merged seam the
pending integration must land on (`recordRemedyEffect` + `canReleaseRemedyRefund`). Any
gap found here becomes a new fixed-scope implementation issue, never hidden in the proof.

## Observability and reconciliation

Production-facing signals are defined and unit-tested in
`reconciliation-signals.ts` (Settlement liability-allocation read model), following the
platform reconciliation convention (pure evaluators returning `ok | alarm`). They detect:
coverage requests by result/reason; outstanding and expired reservations; provider refund
completed but allocation not settled; seller debit inconsistent with allocation;
protection consumption inconsistent with refund; support case marked complete with a
pending effect; reservations older than the policy threshold; quarantined and rejected
event counts; and return-trigger-to-refund / refund-to-reconciliation latency.

The daily reconciliation query `computeDailyReconciliationByCurrency` ties refund totals
to seller-funded and platform-funded postings by currency and reports the explainable
in-flight (authorized) and quarantined balances, so the day balances by currency instead
of assuming everything settled. The repair queue and drift metric already exist in
`liability-allocation-queries.ts`.

## Rollout controls

Rollout is gated by `coverage-rollout-policy.ts` (Settlement protection-coverage domain),
a pure gate on NEW platform-funded reservation authorizations.

- **Enable** — the pre-launch default is `disabled`. Set the rollout `mode` to `internal-only` (authorized internal operators,
  bounded monetary limit), then `cohort` (named policy cohorts, optional tighter per-cohort
  limits), then `general` (everyone within the global limit). Start with authorized internal
  operators and bounded monetary limits.
- **Pause** — set `mode: paused`. New authorizations stop immediately; reservations and
  remedies already in flight are unaffected and remain recoverable.
- **Rollback** — set `mode: rolled-back`. Like pause, it stops new authorizations without
  invalidating active reservations/remedies; re-enable is refused until a
  `forwardRepairReference` records the repair that reconciled in-flight cases.
- **Forward-repair** — the ADR 0020 wallet-adjustment correction path (#5220) repairs an
  incorrect posting; J12 proves the corrected allocation posts zero new seller debit.

Rollback stops new authorizations without invalidating active reservations/remedies:
`preservesActiveReservations` is true in every mode because settle/release/expire are never
gated. Active cases remain recoverable if the rollout is paused.

## SLOs and escalation ownership

Defined in `platformCoverageRolloutSlos` (`coverage-rollout-policy.ts`):

- Reservation decision p95 ≤ 5s — owner: Settlement on-call.
- Refund-to-reconciliation p95 ≤ 24h — owner: Settlement on-call.
- Quarantine acknowledgement ≤ 4h — owner: Settlement on-call.
- Refund execution — owner: Payments on-call.
- Reverse logistics — owner: Fulfillment on-call.
- Case adjudication — owner: Support on-call.

## Acceptance confirmation (sign-off gate)

A release can claim operator acceptance for platform-funded resolution reconciliation only
when the PR body or release plan names:

- the journeys covered by ID (J1–J13) and the two automated proofs that back them;
- the reconciliation signals wired to a dashboard/alert and the daily by-currency report;
- the rollout mode at launch (start `internal-only` with bounded limits) and the tested
  enable / pause / rollback / forward-repair procedures;
- any accepted non-blocking gap (e.g. the carrier-accepted auto-trigger seam) and its
  follow-up issue;
- the SLOs and the named escalation owner per context.

## Related references

- Terminal-evidence coordination: #3733, #571, #596, #572.
- This packet's issue: #5223 (epic #5210, reverse-logistics #5211).
- Contracts: `docs/adr/0022-platform-covered-resolution-contracts.md`.
