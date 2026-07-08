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
- `checkout`: active; stock reserved during a checkout payment step before order creation.
- `pos`: Planned; stock committed by a point-of-sale interaction.
- `channel`: Planned; stock committed by an external sales channel.
- `transfer`: Planned; stock committed for movement between Inventory locations or owners.

## Hold Source Reference

A **Hold Source Reference** is the structured owner reference for an Inventory Hold.

Notes:

- Order holds reference the `orderId` and `reservationRequestId` that own the commitment.
- Checkout holds reference the `checkoutSessionId` and line key that own the payment-step reservation.
- Manual holds have no source reference.

## Hold Expiry

A **Hold Expiry** is the optional time when an Inventory Hold can expire automatically.

Notes:

- Order and manual holds do not expire automatically.
- Checkout holds use expiry so abandoned payment-step reservations can leave the held state without manual action.

## Expired Hold

An **Expired Hold** is a checkout hold that reached its expiry time before conversion to an order hold.

Notes:

- Expiry is a terminal hold state distinct from release.
- Expired checkout holds emit `inventory.hold.expired` so abandonment analytics and buyer messaging stay honest.
- Expired holds no longer reduce Available Quantity.

## Hold Release Reason

A **Hold Release Reason** is the structured reason an active Inventory Hold left the held state without consuming stock.

Values:

- `order-cancelled`: an Ordering-owned order cancellation released the hold.
- `checkout-expired`: a planned checkout hold expired before order commitment.
- `payment-deadline`: a planned payment-deadline cancellation released the hold.
- `manual`: an account-initiated Inventory action released the hold.
- `superseded`: a newer hold or lifecycle transition replaced the hold.

## Restock Decision

A **Restock Decision** is a seller choice for stock that has already left pre-shipment handling and later came back through a return or post-dispatch cancellation.

Notes:

- Restock Decisions are Inventory-owned because Inventory owns whether returned stock increases available quantity.
- A pending Restock Decision asks the seller to choose whether returned stock should be restocked or written off.
- Pre-shipment cancellations do not require Restock Decisions because the stock can return to available quantity automatically.
- Pending restock-decision stock is not available and is not held.
- `Restock` records the decision and adjusts the Inventory Item quantity up with reason `return-restocked`.
- `Write off` records the decision with outcome `written-off` and does not change quantity.
- Restock decisions carry order provenance so the Inventory Item ledger can link back to the sale.

## Restock Decision Outcome

Values:

- `restocked`: the seller accepted the returned unit back into stock.
- `written-off`: the seller chose not to return the unit to stock, usually because condition or identity is not acceptable.

## Inventory Adjustment Reason

Values added by returned-stock decisions:

- `return-restocked`: a seller restocked units from a returned order after reviewing the item.

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

## Planned Store, Location, And Channel Inventory

These planned terms pre-register upcoming store, multi-location, and channel inventory language. They are not shipped behavior until Inventory adds the corresponding aggregates, events, imports, exports, and read models.

### Store

A **Store** is the planned account-operated selling presence that may group inventory, listings, channels, and fulfillment preferences.

### Storefront

A **Storefront** is the planned public or channel-specific presentation of a Store's sellable inventory.

### Store Profile

A **Store Profile** is the planned account-managed descriptive and operational configuration for a Store.

### Location Group

A **Location Group** is the planned Inventory grouping for related Storage Locations.

### Stock Zone

A **Stock Zone** is the planned operational area inside a Storage Location.

### Bin

A **Bin** is the planned smallest named stock placement unit Inventory may track.

### Shelf

A **Shelf** is the planned storage subdivision used to organize Bins or stock.

### Aisle

An **Aisle** is the planned storage path grouping Shelves or Stock Zones.

### Location Transfer

A **Location Transfer** is the planned movement of stock between Storage Locations.

### Transfer Batch

A **Transfer Batch** is the planned group of Location Transfer lines moved together.

### Transfer Line

A **Transfer Line** is the planned product and quantity row inside a Transfer Batch.

### Transfer Status

**Transfer Status** is the planned lifecycle state of a Location Transfer.

### Replenishment Need

A **Replenishment Need** is the planned Inventory signal that stock should be moved or acquired.

### Inventory Count

An **Inventory Count** is the planned physical or operational count of stock on hand.

### Cycle Count

A **Cycle Count** is the planned recurring count of a subset of inventory.

### Count Variance

A **Count Variance** is the planned difference between recorded quantity and counted quantity.

### Stock Ledger

A **Stock Ledger** is the planned account-facing history of quantity-affecting Inventory facts.

### Channel Stock Allocation

A **Channel Stock Allocation** is the planned quantity reserved for a specific external or native sales channel.

### Channel Allocation Mode

A **Channel Allocation Mode** is the planned rule for how inventory quantity is shared, capped, or reserved across channels.

### Channel Allocation

A **Channel Allocation** is the planned Inventory quantity assignment for a native or external sales channel.

### Channel Reservation

A **Channel Reservation** is the planned temporary channel-sourced hold against available inventory.

### Channel Listing Link

A **Channel Listing Link** is the planned association between a Chase Sets Listing or Inventory Item and an external channel listing.

### Channel Sync

**Channel Sync** is the planned Inventory workflow that reconciles stock facts with an external sales channel.

### Channel Sync Run

A **Channel Sync Run** is the planned execution record for one Channel Sync attempt.

### Channel Sync Error

A **Channel Sync Error** is the planned actionable failure captured during Channel Sync.

### Channel Inventory Snapshot

A **Channel Inventory Snapshot** is the planned channel-reported quantity state captured for reconciliation.

### Channel Fulfillment Rule

A **Channel Fulfillment Rule** is the planned Inventory-owned rule that decides which stock can satisfy channel demand.

### Offline Sale

An **Offline Sale** is the planned Inventory fact that stock left availability through an in-person or non-channel sale.
