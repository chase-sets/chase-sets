# Inventory Bounded Context

## Purpose

Inventory owns seller-held stock and its operational availability.

## Owns

- Inventory lots
- Quantities on hand
- Seller-specific condition assessments
- Acquisition cost and cost basis
- Storage locations
- Reservation state
- Bulk ingestion workflows

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
- Ingestion Batch

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
3. Inventory availability must be derived from on-hand quantity minus active reservations.
4. A listing can only be created from inventory that is available for sale.

## Open Extraction Candidates

- Warehouse operations can be extracted later if multi-location fulfillment becomes materially more complex.
