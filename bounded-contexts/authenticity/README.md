# Authenticity Bounded Context

## Purpose

Authenticity owns the judgment lifecycle for authenticity-checked orders: it
records the case created when an authenticity-checked order is placed, the
inspection verdict, and the forward-or-return outcome. It is the foundation
slice for the m109 Authenticity Check milestone (epic #4284).

## Owns

- Authenticity Case
- Authenticity Verdict and Verdict Reason Code
- Case read models: the operator inspection queue and per-order case status
- The `authenticityFacilityDirectory` provider-port seam

## Does Not Own

- Package movement, tracking, and delivery facts (Fulfillment)
- The delivered fact that matures payout funds and review eligibility
  (Fulfillment emits it; Settlement and Marketplace consume it)
- Authenticity fee policy and buyer checkout opt-in (m109 #4275)
- The inspection workbench UI and operator workflow (m109 #4277)
- Verdict reactions such as refunds, risk flags, and moderation escalation
  (m109 #4278)
- Facility address and operating identity values (platform config behind the
  facility directory port, not context-owned domain state)

## Ubiquitous Language

Authenticity terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- AuthenticityCase

## Incoming Dependencies

- None wired yet. The case-opening command carries an order/listing snapshot
  reference and an authenticity plan reference; wiring the real
  order-placed-with-authenticity-plan integration event is m109 #4275/#4276
  (checkout produces the fact, fulfillment coordinates the two-leg delivery).

## Outgoing Integration Events

- `authenticity.case.opened`
- `authenticity.case.inbound-tracking-recorded`
- `authenticity.case.received`
- `authenticity.case.inspection-started`
- `authenticity.case.verdict-recorded`
- `authenticity.case.forwarded`
- `authenticity.case.returned`

## Invariants

1. A case follows exactly one path: `awaiting-inbound` -> `received` ->
   `inspecting` -> a verdict (`passed`, `failed`, `inconclusive`) ->
   `forwarded` (from `passed` only) or `returned` (from `failed` or
   `inconclusive` only). Illegal transitions are rejected.
2. Verdicts are per-order and all-or-nothing in v1: per-line notes are
   recorded but never produce partial forwarding.
3. A passed verdict carries no reason codes; a failed or inconclusive
   verdict requires at least one Verdict Reason Code and at least one
   evidence photo reference.
4. `authenticity.case.received` records leg-1 (seller -> facility) arrival
   only. It must never be treated as the delivered fact that matures payout
   funds or creates review eligibility -- only leg-2 (facility -> buyer)
   delivery does that.
5. Facility address and operating identity are platform config behind the
   `authenticityFacilityDirectory` port; Authenticity never models a
   Facility aggregate.

## Tests

Run `pnpm --filter @chase-sets/authenticity run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/authenticity run test` before opening a PR.
