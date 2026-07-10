# Inventory Bounded Context

## Purpose

Inventory owns account-held stock, its storage structure, its ship-from location mapping, and its operational availability.

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
- Bulk stock import workflows

## Does Not Own

- Public listings
- Offers
- Orders
- Shipments

## Ubiquitous Language

Inventory terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Automatic listing stock policy is documented in [Automatic Listing Stock](./docs/automatic-listing-stock.md).
Import product resolution is documented in [Import Product Resolution](./docs/import-product-resolution.md).

## Core Aggregates and Process Managers

- Inventory Item
- Hold
- Import Batch

## Incoming Dependencies

- Identity for account references
- Catalog for canonical item identity

## Outgoing Integration Events

- `InventoryItemCreated`
- `InventoryAvailabilityChanged`
- `InventoryHeld`
- `InventoryReleased`
- `InventoryItemAdjusted`

## Invariants

1. Inventory is private account state.
2. Every inventory item belongs to exactly one owner account.
3. Every inventory item belongs to exactly one resolved product and one storage location.
4. Every storage location maps to exactly one ship-from location.
5. Inventory availability must be derived from total quantity minus active holds.
6. A listing can only be created from inventory that is available for sale.
7. Reserved stock must preserve the ship-from location derived from its storage location so downstream shipping prices can use a single shipment origin.
8. Platform import rows must resolve to Catalog-owned Product identity before they create inventory or draft listings.

## Tests

Run `pnpm --filter @chase-sets/inventory run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/inventory run test` before opening a PR.

## Open Extraction Candidates

- Warehouse topology and location-based fulfillment orchestration can be extracted later if multi-location fulfillment becomes materially more complex.
