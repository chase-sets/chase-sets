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

## Invariants

1. Fulfillment starts only after Ordering marks an order ready.
2. A single order may map to one or more shipments.
3. Tracking state is owned only in Fulfillment.
4. Fulfillment issues facts that may trigger refunds, but it does not execute refunds.
5. A shipment may be cancelled for buyer self-service cancellation only before packing starts.

## Tests

Run `pnpm --filter @chase-sets/fulfillment run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/fulfillment run test` before opening a PR.

## Open Extraction Candidates

- Returns management can be extracted later if reverse logistics becomes a large standalone workflow.
