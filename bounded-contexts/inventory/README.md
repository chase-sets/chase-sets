# Inventory Bounded Context

## Purpose

Inventory owns seller-held stock, its storage structure, its ship-from location mapping, and its operational availability.

Inventory items do not target a bare catalog item. They target a resolved product:

- `catalogItemId`
- `productId`
- normalized `selectedOptions`

If an item uses a `condition` dimension, that condition is chosen through the selected product options. Inventory does not maintain a separate seller-specific condition field.

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
- Buyer offers
- Orders
- Shipments

## Ubiquitous Language

Inventory terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Inventory Item
- Hold
- Import Batch

## Incoming Dependencies

- Identity for seller account references
- Catalog for canonical item identity

## Outgoing Integration Events

- `InventoryItemCreated`
- `InventoryAvailabilityChanged`
- `InventoryHeld`
- `InventoryReleased`
- `InventoryItemAdjusted`

## Invariants

1. Inventory is private seller state.
2. Every inventory item belongs to exactly one seller account.
3. Every inventory item belongs to exactly one resolved product and one storage location.
4. Every storage location maps to exactly one ship-from location.
5. Inventory availability must be derived from total quantity minus active holds.
6. A listing can only be created from inventory that is available for sale.
7. Reserved stock must preserve the ship-from location derived from its storage location so downstream shipping prices can use a single shipment origin.

## Open Extraction Candidates

- Warehouse topology and location-based fulfillment orchestration can be extracted later if multi-location fulfillment becomes materially more complex.
