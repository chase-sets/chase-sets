# Fulfillment Domain Glossary

This glossary defines the canonical terminology for the Fulfillment bounded context.

## Shipment

A **Shipment** is the physical delivery workflow that fulfills an order.

Notes:

- Shipments are owned by Fulfillment.
- Shipment tracking is not owned by Ordering or Payments.

## Package

A **Package** is the packed unit prepared for carrier handoff within a shipment workflow.

## Tracking Identifier

A **Tracking Identifier** is the carrier-issued or carrier-linked reference used to monitor shipment progress.

## Shipping Method

A **Shipping Method** is the selected fulfillment service level or delivery path for a shipment.

## Fulfillment Exception

A **Fulfillment Exception** is a delivery problem or operational issue that requires downstream handling.

Examples:

- Lost in transit
- Damaged package
- Return to sender
