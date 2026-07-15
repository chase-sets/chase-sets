# Fulfillment Bounded Context

## Purpose

Fulfillment owns the physical execution of shipping and delivery.

## Owns

- Ship-from Locations
- Shipment
- Package assembly state
- Packing start and completion
- Packing slip preparation
- Shipping method selection
- Label purchase references
- Tracking identifiers
- Dispatch and in-transit status
- Delivery, loss, return, and exception handling
- Shipment cancellation before package preparation
- Return Shipment (buyer-to-platform reverse movement) aggregate and read models
- Platform return-facility destination directory and immutable destination snapshots
- Reverse-shipment custody milestones, deadlines, and carrier exceptions
- Reverse-shipment linkage to the authorizing support request, remedy, order, outbound shipment, and affected order lines

## Does Not Own

- Order pricing
- Order cancellation decisions
- Payment capture logic
- Buyer refund execution
- Seller balances

## Ubiquitous Language

Fulfillment terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Buyer self-service purchase cancellation cutoff policy is documented in [Purchase Cancellation Cutoff](./docs/purchase-cancellation-cutoff.md).

## Core Aggregates and Process Managers

- Shipment
- Package
- Fulfillment Exception
- Return Shipment

## Incoming Dependencies

- Ordering for order readiness
- Identity for transaction-party account references

## Operations

Postage provider configuration and label smoke checks live in [Postage Operations](../../docs/runbooks/postage-operations.md).

## Outgoing Integration Events

- `ShipmentCreated`
- `ShipmentPackingStarted`
- `ShipmentLabelAttached`
- `ShipmentCancelled`
- `ShipmentDispatched`
- `ShipmentDelivered`
- `ShipmentReturned`
- `ShipmentExceptionRaised`
- `fulfillment.return-shipment.requested.v2`
- `fulfillment.return-shipment.label-ready.v1`
- `fulfillment.return-shipment.carrier-accepted.v1`
- `fulfillment.return-shipment.in-transit-recorded.v1`
- `fulfillment.return-shipment.delivered.v1`
- `fulfillment.return-shipment.facility-intake-completed.v1`
- `fulfillment.return-shipment.facility-intake-corrected.v1`
- `fulfillment.return-shipment.duplicate-intake-scan-observed.v1`
- `fulfillment.unidentified-return-package.recorded.v1`
- `fulfillment.unidentified-return-package.reconciled.v1`
- `fulfillment.return-shipment.cancelled.v1`
- `fulfillment.return-shipment.expired.v1`
- `fulfillment.return-shipment.exception-raised.v1`

## Invariants

1. Fulfillment starts only after Ordering marks an order ready.
2. A single order may map to one or more shipments.
3. Tracking state is owned only in Fulfillment.
4. Fulfillment issues facts that may trigger refunds, but it does not execute refunds.
5. A shipment may be cancelled for buyer self-service cancellation only before packing starts.

## Tests

Run `pnpm --filter @chase-sets/fulfillment run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/fulfillment run test` before opening a PR.

## Platform-Covered Resolutions

For platform-covered resolutions (epic #5210), Fulfillment owns any buyer-to-platform
reverse shipment and its physical delivery/intake facts (`returnShipmentId`); those
facts gate the `delivered` and `facility-intake` refund triggers a remedy may choose.
The existing `ShipmentReturned` terminal state is the outbound shipment reaching
"returned" — it is **not** a reverse shipment. Ownership and the refund-trigger contract are
ratified in [ADR 0022: Platform-Covered Resolution Ownership and Contracts](../../docs/adr/0022-platform-covered-resolution-contracts.md).

## Return Shipment (buyer-to-platform reverse logistics)

The `return-shipments` slice owns a dedicated, event-sourced **Return Shipment**
aggregate for buyer-to-platform reverse movements, kept separate from the outbound
`Shipment` on purpose: a reverse movement has its own origin, destination, label,
tracking, custody milestones, deadlines, cost payer, and exception paths, so
overloading the outbound aggregate would blur its invariants and make retries,
claims, and reconciliation unsafe. The `fulfillment.shipment.returned` state stays
exactly what it is — an outbound shipment turned back to the seller — and its tests
are unchanged.

The slice also owns a typed platform return-facility destination directory with
deterministic, policy-versioned selection and an explicit no-eligible-facility
result. The chosen facility is captured as an immutable destination snapshot on the
`requested` fact, so later directory changes never rewrite history, and facility
secrets never reach the event log or the customer read model. Customer-safe and
operator read models are projected separately, so protected facility and party
metadata cannot leak to buyers by construction. The design is recorded in
[ADR 0023: ReturnShipment Aggregate and Platform Return-Facility Directory](../../docs/adr/0023-return-shipment-aggregate.md).
Before creation, Fulfillment validates the Support-owned case, remedy, order, and
affected-line facts against its own outbound shipment and line projection. The
complete immutable linkage is then stamped into the aggregate fact and operator
read model; a retry is idempotent only when every linked identifier agrees.
Facility intake extends the same aggregate with evidence-gated custody completion,
structured discrepancy ownership and next actions, append-only corrections, and
duplicate-scan observations. Unidentified packages use a separate Fulfillment-owned
event stream so later reconciliation can link a Return Shipment without rewriting
the original receipt evidence. Intake evidence is private, content-validated,
security-scanned, and access-scoped to return-intake operators at the assigned
facility. The operational procedure is in
[Facility Return Intake](../../docs/runbooks/facility-return-intake.md).

## Open Extraction Candidates

- Returns management can be extracted later if reverse logistics becomes a large standalone workflow.
