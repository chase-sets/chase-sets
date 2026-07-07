# Inventory Domain Glossary

This glossary defines the canonical terminology for the Inventory bounded context.

## Inventory Item

An **Inventory Item** is a seller's stock for one specific product and storage location.

Notes:

- Every inventory item belongs to exactly one owner account.
- Every inventory item references one `CatalogItemId`, one `ProductId`, and one normalized selected-options snapshot.
- Every inventory item belongs to exactly one storage location.
- If condition matters for the item, it is part of the selected dimensions for that product.
- Marketplace may reference inventory availability, but Inventory owns the stock truth.

## Total Quantity

**Total Quantity** is the number of units recorded in an inventory item before active holds are applied.

## Available Quantity

**Available Quantity** is the number of units in an inventory item that can still be sold after active holds are applied.

## Hold

A **Hold** is a temporary block against available stock while checkout or another in-progress commerce flow completes.

## Hold Purpose

A **Hold Purpose** is the structured reason an Inventory Hold exists.

Values:

- `order`: active; stock committed to an Ordering-owned order reservation.
- `manual`: active; stock held by an account-initiated Inventory action.
- `checkout`: Planned; stock reserved during a checkout payment step.
- `pos`: Planned; stock committed by a point-of-sale interaction.
- `channel`: Planned; stock committed by an external sales channel.
- `transfer`: Planned; stock committed for movement between Inventory locations or owners.

## Hold Source Reference

A **Hold Source Reference** is the structured owner reference for an Inventory Hold.

Notes:

- Order holds reference the `orderId` and `reservationRequestId` that own the commitment.
- Manual holds have no source reference.

## Hold Expiry

A **Hold Expiry** is the optional time when an Inventory Hold can expire automatically.

Notes:

- Order and manual holds do not expire automatically.
- Planned checkout holds will use expiry so abandoned payment-step reservations can release stock without manual action.

## Hold Release Reason

A **Hold Release Reason** is the structured reason an active Inventory Hold left the held state without consuming stock.

Values:

- `order-cancelled`: an Ordering-owned order cancellation released the hold.
- `checkout-expired`: a planned checkout hold expired before order commitment.
- `payment-deadline`: a planned payment-deadline cancellation released the hold.
- `manual`: an account-initiated Inventory action released the hold.
- `superseded`: a newer hold or lifecycle transition replaced the hold.

## Restock Decision

A **Restock Decision** is a seller choice for returned stock after the item has already left pre-shipment handling.

Notes:

- Restock Decisions are Inventory-owned because Inventory owns whether returned stock increases available quantity.
- A pending Restock Decision asks the seller to choose whether returned stock should be restocked or written off.
- Pre-shipment cancellations do not require Restock Decisions because the stock can return to available quantity automatically.

## Storage Location

A **Storage Location** is a seller-defined place where stock is stored.

Notes:

- An account may have more than one storage location.
- A storage location may be as broad as a room or as granular as a bin, shelf, or aisle.
- Each storage location maps to exactly one ship-from location.

## Import

An **Import** is a bulk inventory upload that creates or updates inventory items.

Notes:

- Imports are review-first.
- Platform imports resolve ordered external reference candidates through Catalog-owned product references.
- Accepted import rows can create inventory and draft listings; rejected rows stay in review until product, quantity, location, or listing draft issues are resolved.

## Import Source Profile

An **Import Source Profile** is Inventory-owned configuration that describes how rows from a source platform become Inventory import rows.

Notes:

- A profile defines the source key, label, file/API kind, header aliases, quantity and price fields, seller SKU fields, listing draft fields, external reference candidates, candidate target intent, and selected option inference rules.
- Small connectors parse files or fetch rows; profiles decide row semantics.
- Profiles are seeded in code today so common platform migration paths work without manual setup.

## External Reference Candidate

An **External Reference Candidate** is a provider-scoped identifier captured from an import row before Inventory resolves it to a Chase Sets Product.

Notes:

- Examples include a TCGplayer SKU, eBay listing ID, Shopify variant ID, Whatnot product ID, CardTrader blueprint ID, or barcode.
- Inventory tries candidates in profile order and uses target intent to decide whether a candidate should check Catalog Item references, Product references, or future account SKU mappings.
- External Reference Candidates are row evidence, not Inventory-owned product truth.

## Acquisition Cost

**Acquisition Cost** is the seller's recorded cost to acquire stock in inventory.
