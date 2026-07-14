# ADR 0023: ReturnShipment Aggregate and Platform Return-Facility Directory

## Status

Accepted. Establishes the Fulfillment-owned foundation for buyer-to-platform reverse
logistics: a dedicated `ReturnShipment` aggregate, a platform return-facility
destination directory, and separately projected customer-safe and operator read
models. It builds on the vocabulary and ownership fixed by ADR 0022 (the
`ReturnDirective` value object and the Fulfillment-owned `returnShipmentId`) and
precedes the label-issuance and tracking/exception leaves that consume it.

Scope note: no carrier label purchase, webhook ingestion, refund release, facility
scan UI, or recovered-inventory creation is decided here.

## Context

The existing Fulfillment `Shipment` aggregate models an outbound movement, and its
`fulfillment.shipment.returned` state is a terminal fact on that outbound shipment —
the carrier turned the parcel back to the seller. That is not a buyer-to-platform
reverse shipment. A reverse movement to a platform facility has its own origin,
destination, label, tracking, custody milestones, deadlines, cost payer, and
exception paths. Overloading the outbound aggregate would blur its invariants and
make retries, claims, and reconciliation unsafe.

ADR 0022 already ratified that Fulfillment owns any reverse shipment and its
physical delivery/intake facts (`returnShipmentId`), that platform coverage is not
synonymous with return-to-platform, and that return destination is orthogonal to
refund timing. This ADR turns that ownership into a concrete aggregate.

## Decision

### A distinct aggregate, not an outbound-shipment state

`ReturnShipment` is its own event-sourced aggregate in the fulfillment
`return-shipments` slice, keyed by a Fulfillment-owned `returnShipmentId` (`rsh_`).
It never mutates an outbound `Shipment`. Its stream is
`fulfillment.return-shipment-<id>`.

Creation is **idempotent by remedy and return directive**: replaying the request on
a stream is a no-op, but reusing a stream for a different remedy or a directive
other than `return-to-platform` is rejected. The read model additionally supports a
one-return-shipment-per-remedy lookup so the creation flow does not presume a second
aggregate exists.

### Lifecycle

The happy path advances monotonically through delivery stages:
`requested → ready-to-ship → carrier-accepted → in-transit → delivered → received`.
`delivered` (the carrier handed the parcel to the facility address) and `received`
(the facility acknowledged intake) are deliberately **separate facts** — a carrier
delivery scan is not a custody handoff. `cancelled` and `expired` are terminal
off-ramps reachable only before the parcel is in carrier custody. Carrier
exceptions are an **overlay**, not a lifecycle stage, so a lost, delayed, damaged,
or unscannable scan never regresses the furthest stage reached.

Carrier milestones use a monotonic stage rank: a milestone advances the recorded
status only when its target stage is strictly ahead of the current stage. Duplicate
and out-of-order carrier events therefore converge without regressing custody
state, and replay is deterministic.

### Platform return-facility directory

A typed, validated, Fulfillment-owned directory describes active platform
facilities: stable facility id and configuration version, effective/retired dates,
supported return programs, carriers, regions, and package constraints, a postal
address used to create a label, display-safe name and instructions, and restricted
operational contact and internal routing metadata.

Facility selection is **deterministic and policy-versioned**: it filters to
facilities active at the selection time that support the requested program,
carrier, and region and accept the parcel, then chooses the eligible facility with
the lowest facility id (a total order). When nothing qualifies it returns an
explicit `no-eligible-facility` result rather than throwing.

When a facility is chosen, the selection is captured as an immutable
`ReturnDestinationSnapshot` stamped onto the `requested` fact. The snapshot carries
the postal address (needed to create a label), display copy, facility id/version,
and selection policy version — but never the restricted operational contact or
internal routing code, so those secrets stay out of the event log. Later directory
edits never rewrite the snapshot, so history stays auditable.

Reverse logistics is generic Fulfillment behaviour, so the directory lives in
Fulfillment. Authenticity may judge a specific item on request but does not own
return routing, and Fulfillment does not depend on Authenticity persistence.

### Separately projected read models

Two read models are projected independently:

- The **customer** page carries only display-safe destination copy, region,
  carrier, tracking, deadlines, status, and exception type. It has no facility
  postal address, no facility id/version, no ship-from party address, no
  operational routing, and no cost allocation, so a customer query cannot leak
  protected metadata by construction.
- The **operator** page carries the destination snapshot, ship-from snapshot,
  custody timeline, exceptions, deadlines, cost payer, and correlation metadata so
  operators can resolve exceptions without joining another context's database.

### Versioned facts

The aggregate publishes versioned `.v1` facts for creation, label readiness,
carrier milestones, delivery, receipt/intake, cancellation/expiry, and exceptions,
following the native-event versioning precedent set by ADR 0021. Each fact carries
correlation (the remedy id), causation, idempotency, and policy-version metadata;
the acting operator is the event envelope's audit block, not duplicated in the
payload.

## Alternatives considered

- **Extend the outbound `Shipment` with a reverse mode.** Rejected: it overloads the
  outbound invariants (origin/destination inversion, different cost payer, custody,
  deadlines) and makes retries and reconciliation ambiguous, exactly the coupling
  epics #5210/#5211 remove.
- **Own the facility directory in Authenticity.** Rejected: reverse logistics is
  generic Fulfillment behaviour; coupling it to Authenticity persistence would make
  Fulfillment depend on a context that only judges specific items.
- **One combined read model with row-level redaction.** Rejected: a single table
  makes leaking protected fields a query-authoring mistake away. Separate customer
  and operator projections make the customer surface safe by construction.
- **Collapse `delivered` and `received` into one terminal state.** Rejected: custody
  and refund triggers depend on the facility acknowledging intake, which a carrier
  delivery scan does not establish.

## Consequences

- The label-issuance leaf can attach a carrier label and mark the shipment
  ready-to-ship on this aggregate; the tracking/exception/refund-trigger leaf can
  project deadlines and drive refund triggers off these facts; the facility-intake
  leaf can enrich `received` with discrepancy evidence and chain of custody.
- The existing outbound shipment tests and its `returned` terminal state are
  unchanged; the boundary between the two is documented in the Fulfillment README
  and glossary.
- The new `returnShipmentId` brand and the `.v1` fact names are the canonical
  vocabulary the sibling reverse-logistics leaves build on.
