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

## Return Shipment

A **Return Shipment** is the buyer-to-platform reverse movement that routes an item from a buyer directly to a platform-controlled facility when a support resolution requires platform custody, inspection, or recovery.

Notes:

- A Return Shipment is a distinct aggregate with its own identity, origin, destination, label, tracking, custody milestones, deadlines, exceptions, and cost payer.
- Its immutable source linkage names the authorizing Support Request and remedy, the order and outbound Shipment, and every affected order line traveling in the return.
- Fulfillment validates Support-owned case/remedy facts against Fulfillment-owned shipment/line facts before creating the aggregate; cross-case, cross-order, and unrelated-line combinations are rejected.
- It is not the outbound Shipment's terminal `returned` state. Overloading the outbound Shipment would blur its invariants.
- Creation is idempotent by remedy and return directive; reusing a stream for a different remedy or directive is rejected.
- `Delivered` (the carrier handed the parcel to the facility address) and `Received` (the facility acknowledged intake) remain separate facts.

## Return Destination Directory

A **Return Destination Directory** is the Fulfillment-owned, typed and validated configuration of active platform return facilities a Return Shipment can be routed to.

Notes:

- Selection is deterministic and policy-versioned, with an explicit no-eligible-facility result.
- Operational contact and internal routing metadata are restricted to authorized consumers and never placed on broadly consumed contracts.
- Reverse logistics is generic Fulfillment behavior; the directory does not move ownership into Authenticity.

## Return Destination Snapshot

A **Return Destination Snapshot** is the immutable, label-safe destination captured onto a Return Shipment when a facility is selected.

Notes:

- It carries the postal address needed to create a label plus display-safe copy and the facility id and configuration version for audit.
- It excludes facility secrets, so later directory configuration changes never rewrite history.

## Facility Intake

**Facility Intake** is the platform-facility workflow that acknowledges receipt of a Return Shipment, distinct from carrier delivery.

Notes:

- Intake establishes platform custody; carrier `Delivered` alone does not.
- Completion requires the facility, station, operator, receipt timestamp, package and seal condition, custody identifier, private evidence, and at least one expected or discrepancy state.
- Duplicate and racing scans preserve one completion and return the accepted custody result.
- A correction never replaces prior evidence; it appends a reasoned, permissioned fact.

## Return Intake Discrepancy

A **Return Intake Discrepancy** is a structured facility observation that the package is missing, extra, substituted, damaged, empty, or unreadable instead of matching expected contents.

Notes:

- Every state, including expected contents, records an owner and next action.
- Any discrepancy requires evidence and routes the package to quarantine or manual review.

## Unidentified Return Package

An **Unidentified Return Package** is a package physically received by a platform facility that cannot yet be resolved to exactly one expected Return Shipment.

Notes:

- It receives its own custody identifier and immutable receipt evidence.
- Later reconciliation links it to a Return Shipment without rewriting the original package history.

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
