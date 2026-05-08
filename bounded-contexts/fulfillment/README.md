# Fulfillment Bounded Context

## Purpose

Fulfillment owns the physical execution of shipping and delivery.

## Owns

- Ship-from Locations
- Shipment
- Package assembly state
- Shipping method selection
- Label purchase references
- Tracking identifiers
- Dispatch and in-transit status
- Delivery, loss, return, and exception handling

## Does Not Own

- Order pricing
- Payment capture logic
- Seller balances

## Ubiquitous Language

Fulfillment terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

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
- `ShipmentLabelAttached`
- `ShipmentDispatched`
- `ShipmentDelivered`
- `ShipmentReturned`
- `ShipmentExceptionRaised`

## Invariants

1. Fulfillment starts only after Ordering marks an order ready.
2. A single order may map to one or more shipments.
3. Tracking state is owned only in Fulfillment.
4. Fulfillment issues facts that may trigger refunds, but it does not execute refunds.

## Open Extraction Candidates

- Returns management can be extracted later if reverse logistics becomes a large standalone workflow.
