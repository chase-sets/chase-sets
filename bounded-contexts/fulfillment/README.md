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

## USPS Postage Integration

Chase Sets uses EasyPost as the first USPS-compatible postage integration path,
but Fulfillment only depends on the `@chase-sets/postage-labels` port. The
platform API composes either the EasyPost adapter or the sandbox adapter into
Fulfillment through the `postageLabelProvider` host port.

The EasyPost adapter creates shipments from sender and recipient addresses plus
package dimensions and weight, returns USPS rates, buys the selected rate, and
provides the tracking number and label document URL. Local development and tests
use the sandbox adapter unless `EASYPOST_API_KEY` is configured on the platform
API.

Platform API settings:

- `EASYPOST_API_KEY`: server-side EasyPost key. Use a test key for sandbox label
  purchase flow testing.
- `EASYPOST_MODE`: `test` or `production`; defaults to `test`.
- `EASYPOST_API_BASE_URL`: optional override for non-default environments.

USPS label refunds are modeled as label void requests. A voided label moves the
shipment back to awaiting a label while preserving provider refund metadata on
the shipment read model.

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
