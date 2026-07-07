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
- Fulfillment enforces postage-policy outputs already committed to the Package Plan, including signature delivery confirmation, carrier insurance, and Shipping Evidence Tier. It does not resolve the current active Postage Policy.

## Letter Mailpiece

A **Letter Mailpiece** is a non-parcel shipment path for eligible low-risk raw-card orders.

Notes:

- Ordering determines letter eligibility.
- Fulfillment records letter preparation honestly instead of forcing letter shipments through parcel-label purchase.

## Shipping Evidence Tier

A **Shipping Evidence Tier** is the Ordering-evaluated delivery-evidence level that Fulfillment records when buying postage labels.

Notes:

- Fulfillment consumes the committed tier from the Package Plan.
- Label purchase operations record signature and insurance facts with the tier for later dispute-evidence assembly.
- Fulfillment does not recalculate the tier from the current active Postage Policy.

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

## Planned Multi-Location Fulfillment

These planned terms pre-register upcoming multi-location fulfillment language. They are not shipped behavior until Fulfillment adds the corresponding assignment, packing, handoff, and shipment execution facts.

### Fulfillment Location

A **Fulfillment Location** is the planned place from which Fulfillment work can be executed.

### Ship-From Location

A **Ship-From Location** is the planned Fulfillment origin used for carrier rates, labels, and shipment execution.

### Fulfillment Network

A **Fulfillment Network** is the planned set of Fulfillment Locations available to an Account or Store.

### Fulfillment Route

A **Fulfillment Route** is the planned delivery or handoff path selected for a Shipment.

### Fulfillment Assignment

A **Fulfillment Assignment** is the planned decision assigning shipment work to a Fulfillment Location.

### Origin Selection

**Origin Selection** is the planned decision process that chooses a Ship-From Location.

### Split Shipment

A **Split Shipment** is the planned fulfillment outcome where one order requires more than one Shipment.

### Pickup

A **Pickup** is the planned Fulfillment handoff workflow where an order or shipment is collected without parcel delivery.

### Intake

**Intake** is the planned Fulfillment workflow that receives stock, returns, transfers, or authenticity-sensitive items for handling.

### Transfer Shipment

A **Transfer Shipment** is the planned shipment that moves stock between operational locations.

### Packing Station

A **Packing Station** is the planned workspace where Packing work is performed.

### Handoff Scan

A **Handoff Scan** is the planned recorded scan that confirms transfer to a carrier, pickup point, or internal location.

### Location Service Area

A **Location Service Area** is the planned geographic or channel scope a Fulfillment Location can serve.
