# Fulfillment Domain Glossary

This glossary defines the canonical terminology for the Fulfillment bounded context.

## Shipment

A **Shipment** is the physical delivery workflow that fulfills an order.

Notes:

- Shipments are owned by Fulfillment.
- Shipment tracking is not owned by Ordering or Payments.

## Package

A **Package** is the packed unit prepared for carrier handoff within a shipment workflow.

## Packing

**Packing** is the seller-facing package assembly workflow after a shipment is ready and before the package is recorded as packed.

Notes:

- Packing is owned by Fulfillment.
- Starting Packing closes buyer self-service purchase cancellation because seller work has begun.
- Packing completion records package count and moves the shipment to label readiness.

## Package Plan

A **Package Plan** is the immutable package, mailpiece class, dimensions, weight, and measurement-version snapshot committed by Ordering and executed by Fulfillment.

Notes:

- Fulfillment stores the Package Plan on the shipment.
- USPS label purchase defaults to the planned parcel package.
- Operator-supplied package dimensions are an override path, not the normal fulfillment path.
- Fulfillment enforces postage-policy outputs already committed to the Package Plan, including signature delivery confirmation. It does not resolve the current active Postage Policy.

## Letter Mailpiece

A **Letter Mailpiece** is a non-parcel shipment path for eligible low-risk raw-card orders.

Notes:

- Ordering determines letter eligibility.
- Fulfillment records letter preparation honestly instead of forcing letter shipments through parcel-label purchase.

## Packing Slip

A **Packing Slip** is a seller-facing shipment document that lists what should be included in a package.

Notes:

- Packing Slips are owned by Fulfillment.
- Packing Slips do not include prices or payment details.
- A **Letter Packing Slip** is formatted for standard 8.5x11 paper workflows.
- A **Thermal 4x6 Packing Slip** is formatted for thermal-label printer workflows.

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

## Cancellation Cutoff

A **Cancellation Cutoff** is the Fulfillment-owned shipment state boundary that closes buyer self-service purchase cancellation.

Notes:

- The window is open while the shipment is awaiting package preparation.
- The window closes when packing starts.
- After the cutoff, buyer cancellation requests use Support instead of direct cancellation.
