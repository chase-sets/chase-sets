# Inventory Bounded Context

## Purpose

Inventory owns account-held stock, its storage structure, its ship-from location mapping, and its operational availability.

The composition and ownership boundary is ratified in [ADR 0029: My Collection Composition And Saved List Ownership](../../docs/adr/0029-my-collection-composition-and-saved-list-ownership.md).

Inventory items do not target a bare catalog item. They target a resolved product:

- `catalogItemId`
- `productId`
- normalized `selectedOptions`

If an item uses a `condition` dimension, that condition is chosen through the selected product options. Inventory does not maintain a separate account-owned condition field.

## Owns

- Inventory items tied to storage locations
- Quantities on hand
- Resolved product stock
- Acquisition cost and cost basis
- Storage locations and their ship-from location mapping
- Hold state
- Hold-collision decisions and evidence
- Bulk stock import workflows
- Recovered return custody, identification, disposition, and value evidence

## Does Not Own

- Public listings
- Offers
- Orders
- Shipments
- Saved Lists, Tracked Quantity, or Saved List valuation

## Ubiquitous Language

Inventory terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Automatic listing stock policy is documented in [Automatic Listing Stock](./docs/automatic-listing-stock.md).
Import product resolution is documented in [Import Product Resolution](./docs/import-product-resolution.md).
CSV import row formats and examples are documented in [Inventory CSV Import Examples](./docs/import-csv-examples.md).

## Core Aggregates and Process Managers

- Inventory Item
- Hold
- Import Batch

## Incoming Dependencies

- Identity for account references
- Catalog for canonical item identity
- Collections supplies owner-authorized immutable Saved List source snapshots; Inventory owns their review and stock intake.

## Outgoing Integration Events

- `InventoryItemCreated`
- `InventoryAvailabilityChanged`
- `InventoryHeld`
- `InventoryReleased`
- `inventory.hold-collision-recorded`
- `InventoryItemAdjusted`
- `inventory.item.offline-sale-recorded`
- `inventory.recovered-item.authenticity-review-required.v1`
- `inventory.recovered-item.sellable.v1`
- `inventory.recovered-item.transferred.v1`
- `inventory.recovered-item.disposed.v1`
- `inventory.recovered-item.value-reported.v1`

## Invariants

1. Inventory is private account state.
2. Every inventory item belongs to exactly one owner account.
3. Every inventory item belongs to exactly one resolved product and one storage location.
4. Every storage location maps to exactly one ship-from location.
5. Inventory availability must be derived from total quantity minus active holds.
6. A listing can only be created from inventory that is available for sale.
7. Reserved stock must preserve the ship-from location derived from its storage location so downstream shipping prices can use a single shipment origin.
8. Platform import rows must resolve to Catalog-owned Product identity before they create inventory or draft listings.
9. Facility intake creates quarantined recovered stock, never ordinary available stock.
10. A recovered item can become sellable only after identity, inspection, explicit disposition authority, and every policy-required authenticity review are complete.
11. Stock reductions that collide with active holds protect order commitments by default; only an explicit manager-or-owner Honor Offline decision may release affected order reservations.

## Inventory Adjustments

`inventory.item.adjusted` retains its required free-text `reason` and may also carry a typed `reasonCode` plus an optional `note`. Legacy writers that provide only `reason` remain valid. Ledger reads classify a legacy adjusted row with no stored code as `correction`; no other ledger kind receives that fallback.

The producer registry is closed and owned here:

- Operator adjustments choose `damaged`, `lost`, `found`, or `correction`.
- Honor Offline reductions use `sold-offline`.
- Listing-stock top-ups and positive additive imports use `intake`.
- Replace imports and negative additive imports use `correction`.
- Restocked return decisions use `return-restocked`.
- Inventory seed corrections use `correction`.

The separate Restock Decision Outcome `written-off` records the seller's decision without changing quantity, so it emits no inventory adjustment.

## Offline Sales

`inventory.item.offline-sale-recorded` preserves the applied quantity, optional per-unit sale price, Inventory-owned channel, Storage Location, per-unit Acquisition Cost snapshot, and server-recorded time. The companion `inventory.item.adjusted` event remains the only quantity truth.

## Recovered Returns

Inventory consumes Fulfillment's facility-intake fact and creates one deterministic, event-sourced Recovered Item per Return Shipment. Inventory owns the custody audit, duplicate correction and merge workflow, legal-owner and disposition authority evidence, operator queue, terminal disposition, and separate gross recovery and disposition-cost facts. Settlement owns the financial attribution of those value facts. The ownership and policy boundary is ratified in [ADR 0024: Recovered Return Inventory And Protection Recovery](../../docs/adr/0024-recovered-return-inventory-and-value.md).

## Tests

Run `pnpm --filter @chase-sets/inventory run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/inventory run test` before opening a PR.

## Open Extraction Candidates

- Warehouse topology and location-based fulfillment orchestration can be extracted later if multi-location fulfillment becomes materially more complex.
