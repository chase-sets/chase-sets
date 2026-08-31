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

## Stock Authority

**Stock Authority** is the Inventory Item stream's serialization boundary for quantity reductions and new hold commitments. Both operations claim it so concurrent requests resolve in commit order and can never commit the same unit twice.

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
- `checkout-cancelled`: a Checkout-owned session cancellation released the checkout hold before order commitment.
- `checkout-expired`: a planned checkout hold expired before order commitment.
- `payment-deadline`: a planned payment-deadline cancellation released the hold.
- `hold-collision`: an authorized Honor Offline decision released an order hold so recorded offline stock could win.
- `manual`: an account-initiated Inventory action released the hold.
- `superseded`: a newer hold or lifecycle transition replaced the hold.

## Inventory Reservation Authority

**Inventory Reservation Authority** is the complete `inventory.reservation-*` stream history for one Ordering reservation request, read as the canonical answer to whether that request was confirmed or rejected.

Notes:

- Valid authority is exactly a v1 `inventory.reservation.confirmed` or `inventory.reservation.rejected`, optionally followed by a v2 `inventory.reservation.released` that may only follow a confirmation.
- A rejection proves no Hold was ever created; a confirmation supplies the Hold created atomically with it.
- Missing, over-bound, malformed, mixed, repeated, or non-terminal history is not authority. It is never treated as "no reservation".
- The UNLOGGED `inventory_reservation_pages` projection is never this authority.

## Hold Cleanup Authority

**Hold Cleanup Authority** is the complete `inventory.hold-*` stream history for one Hold, read as the canonical answer to whether that Hold is still active or reached a real terminal.

Notes:

- A direct Order Hold is `placed` with Hold Purpose `order` and an exact Hold Source Reference; a converted checkout Hold is `placed` with purpose `checkout`, extended zero or more times, then `converted` to purpose `order`.
- At most one `released`, `consumed`, or `expired` terminal may appear, and nothing may follow it.
- Reading Hold Cleanup Authority never releases, consumes, or otherwise mutates the Hold.

## Hold Source Lookup

A **Hold Source Lookup** is the reverse, exact-tenant query from an Ordering order id to the Hold streams whose Hold Source Reference carries it.

Notes:

- It covers both source-bearing events: a direct `inventory.hold.placed` with purpose `order` and an `inventory.hold.converted` that promotes a checkout Hold.
- Results are ordered by first matching global position, then stream id, and are bounded so an order with more Holds than the contract allows is refused rather than truncated.
- Its authority is the event stream, never a projection.

## Hold Collision

A **Hold Collision** occurs when a requested stock reduction is larger than Available Quantity because active Inventory Holds already commit part of the Inventory Item.

Notes:

- **Protect Orders** is the default: Inventory applies only the available portion and refuses the remainder.
- **Honor Offline** is an explicit manager-or-owner decision: Inventory applies the full reduction and releases the newest whole order reservations needed to restore the commitment floor.
- Earlier order commitments win when only some reservations must be displaced.
- Manual and checkout holds cannot be displaced by Honor Offline.
- Every collision records its quantities, mode, Storage Location, and affected order evidence.

## Protect Orders

**Protect Orders** is the default Hold Collision mode that preserves every active commitment, applies only Available Quantity, and refuses the remainder of the requested reduction.

## Honor Offline

**Honor Offline** is the permission-gated Hold Collision mode in which recorded offline stock wins over the newest affected order commitments. It is chosen for one event and is never a sticky account setting.

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

An **Inventory Adjustment Reason** is the typed reason an Inventory quantity adjustment occurred. It accompanies the required free-text reason without replacing it.

Values:

- `sold-offline`: an Honor Offline reduction recorded stock sold outside an online order.
- `damaged`: an operator removed stock that was damaged.
- `lost`: an operator removed stock that could not be found.
- `found`: an operator added stock that was found.
- `correction`: an operator, seed, or import reconciled recorded stock with known truth.
- `intake`: stock entered Inventory through listing-stock setup or an additive import.
- `return-restocked`: a seller restocked units from a returned order after reviewing the item.

`written-off` is a Restock Decision Outcome, not an Inventory Adjustment Reason. A written-off decision changes no quantity and emits no adjustment.

## Adjustment Note

An **Adjustment Note** is optional operator context attached to an Inventory adjustment. A blank note is stored as no note, and it never replaces or derives from the required free-text reason.

## Offline Sale

An **Offline Sale** is an immutable Inventory fact that records stock sold in person or outside a connected marketplace channel. It preserves sale provenance while the companion Inventory Item adjustment remains the quantity source of truth.

## Offline Sale Channel

An **Offline Sale Channel** identifies where an Offline Sale occurred.

Values:

- `in-store`: sold at the account's store or counter.
- `card-show`: sold at a card show or similar in-person event.
- `other`: sold through another non-connected offline channel.

## Sale Price Amount

**Sale Price Amount** is the optional canonical per-unit amount recorded on an Offline Sale. It is sales provenance without currency, payment, settlement, or provider-receipt meaning.

## Cost Basis Snapshot

A **Cost Basis Snapshot** is the Inventory Item's per-unit Acquisition Cost captured when an Offline Sale is recorded. It remains part of the immutable sale fact even if the item's current cost later changes.

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
- `saved-list` is an API-only source profile. It preserves the selected Saved List version and line evidence, never copies acquisition cost, and requires location review instead of inventing a default.

## External Reference Candidate

An **External Reference Candidate** is a provider-scoped identifier captured from an import row before Inventory resolves it to a Chase Sets Product.

Notes:

- Examples include a TCGplayer SKU, eBay listing ID, Shopify variant ID, Whatnot product ID, CardTrader blueprint ID, or barcode.
- Inventory tries candidates in profile order and uses target intent to decide whether a candidate should check Catalog Item references, Product references, or future account SKU mappings.
- External Reference Candidates are row evidence, not Inventory-owned product truth.

## Acquisition Cost

**Acquisition Cost** is the seller's recorded per-unit cost to acquire stock in inventory.

## Recovered Item

A **Recovered Item** is a physical return in platform custody after Fulfillment completes facility intake. It remains distinct from ordinary available Inventory stock until Inventory proves identity, condition, authority, and any required authenticity outcome.

## Disposition Authority

**Disposition Authority** is the evidence-backed policy decision that records a recovered item's legal owner, the allowed actions, policy version, acting operator, and authority basis. It is required before Inventory returns, resells, liquidates, donates, destroys, or submits a carrier claim for an item.

## Recovered Item Disposition

A **Recovered Item Disposition** is Inventory's append-only decision to return an item to its original seller or buyer, approve platform resale, liquidate, donate, destroy, submit a carrier claim, or record it as lost or unresolved.

## Recovered Value

**Recovered Value** preserves gross proceeds and direct costs separately for resale, liquidation, carrier claims, postage refunds, and disposition costs. Settlement attributes the net result to the original platform-funded Protection Coverage without rewriting the buyer refund.

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
