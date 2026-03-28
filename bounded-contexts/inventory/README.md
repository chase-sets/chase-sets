# Inventory Bounded Context

## Purpose

Inventory owns seller-held stock, its storage structure, its ship-from location mapping, and its operational availability.

## Owns

- Inventory lots tied to storage locations
- Quantities on hand
- Seller-specific condition assessments
- Acquisition cost and cost basis
- Storage locations and their ship-from location mapping
- Reservation state
- Bulk stock import workflows

## Does Not Own

- Public listings
- Buyer offers
- Orders
- Shipments

## Ubiquitous Language

Inventory terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Inventory Lot
- Reservation
- Import Batch

## Incoming Dependencies

- Identity for seller account references
- Catalog for canonical item identity

## Outgoing Integration Events

- `InventoryLotCreated`
- `InventoryAvailabilityChanged`
- `InventoryReserved`
- `InventoryReleased`
- `InventoryLotAdjusted`

## Invariants

1. Inventory is private seller state.
2. Every inventory lot belongs to exactly one seller account.
3. Every inventory lot belongs to exactly one storage location.
4. Every storage location maps to exactly one ship-from location.
5. Inventory availability must be derived from on-hand quantity minus active reservations.
6. A listing can only be created from inventory that is available for sale.
7. Reserved stock must preserve the ship-from location derived from its storage location so downstream shipping prices can use a single shipment origin.

## Open Extraction Candidates

- Warehouse topology and location-based fulfillment orchestration can be extracted later if multi-location fulfillment becomes materially more complex.
