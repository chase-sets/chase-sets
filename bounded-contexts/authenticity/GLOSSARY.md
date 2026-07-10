# Authenticity Domain Glossary

This file is the canonical terminology for the Authenticity bounded context.

The context is named **Authenticity**, deliberately not "Authentication" — that
word collides with the auth/identity vocabulary owned by the `auth` and
`identity` contexts. Product copy and code both say "authenticity check."

## Authenticity Case

An **Authenticity Case** is the judgment record for one authenticity-checked
order, created when the order is placed and closed when the item is forwarded
to the buyer or returned to the seller.

Notes:

- The Authenticity Case aggregate is owned by Authenticity.
- States: `awaiting-inbound` -> `received` -> `inspecting` -> verdict
  (`passed`, `failed`, or `inconclusive`) -> `forwarded` or `returned`.
- One case exists per order. Verdicts are per-order and all-or-nothing in v1:
  per-line notes are recorded, but there is no partial forwarding. This is a
  deliberate v1 constraint, not a platform limitation.
- `authenticity.case.received` marks leg-1 (seller -> facility) delivery
  only. It must never mature payout funds or create review eligibility;
  only leg-2 (facility -> buyer) delivery, owned by Fulfillment and
  consumed by Settlement and Marketplace review eligibility, does that
  (m109 epic critical invariant, #4276).

## Authenticity Verdict

An **Authenticity Verdict** is the inspector's judgment recorded against a
case's order and listing snapshot: `passed`, `failed`, or `inconclusive`.

Notes:

- Recording a verdict requires an inspection checklist, at least one
  evidence photo reference, and the inspector actor.
- A passed verdict carries no reason codes. A failed or inconclusive verdict
  requires at least one Verdict Reason Code.

## Verdict Reason Code

A **Verdict Reason Code** is a structured explanation attached to a failed or
inconclusive Authenticity Verdict: `identity-mismatch`, `condition-mismatch`,
`cert-mismatch`, `counterfeit`, `damage-in-transit`, or `inconclusive`.

Notes:

- Verdict Reason Codes are owned by Authenticity and never freeform text.
- A counterfeit verdict is expected to escalate through moderation and
  support flows owned by other contexts (m107); Authenticity only records
  the reason code and emits the verdict fact.

## Authenticity Facility

The **Authenticity Facility** is the single platform-operated inspection
location that receives, inspects, and forwards or returns packages.

Notes:

- Facility address and operating identity are platform config, not domain
  state — Authenticity does not model a Facility aggregate.
- Access to facility config goes through the `authenticityFacilityDirectory`
  host port. This is the provider-port seam for later third-party
  authenticators and multi-facility routing (Phase 3, not built yet).

## Planned Terms

The following m109 milestone terms are reserved for later phase-1/phase-2
slices (epic #4284) and are not implemented yet.

### Authenticity Claim

An **Authenticity Claim** is the planned seller assertion that a Listing or shipped Product is genuine.

### Authenticity Evidence

**Authenticity Evidence** is the planned evidence set supporting an Authenticity Claim.

### Authenticity Review

**Authenticity Review** is the planned workflow that evaluates Authenticity Evidence.

### Authenticity Decision

An **Authenticity Decision** is the planned outcome of Authenticity Review.

### Authenticity Exception

An **Authenticity Exception** is the planned record of an authenticity-related problem that requires support, refund, or enforcement handling.

### Authenticity Badge

An **Authenticity Badge** is the planned public marker that a Listing, Product, or Account cleared a defined authenticity threshold.

### Authenticity Guarantee

An **Authenticity Guarantee** is the planned marketplace promise attached to eligible authenticity-reviewed commerce.

### Authenticity Dispute

An **Authenticity Dispute** is the planned counterparty challenge that questions an Authenticity Claim or Authenticity Decision.

### Authenticity Chain Of Custody

**Authenticity Chain Of Custody** is the planned provenance record for authenticity-sensitive products or evidence.

### Listing Authenticity Requirement

A **Listing Authenticity Requirement** is the planned rule that requires Authenticity Evidence before a Listing can publish or transact.

### Authenticity Photo Set

An **Authenticity Photo Set** is the planned evidence photo collection attached to a Listing or Authenticity Review.
