# Inventory Domain Glossary

This glossary defines the canonical terminology for the Inventory bounded context.

## Inventory Lot

An **Inventory Lot** is a seller-owned stock record for a specific catalog item, condition assessment, and quantity.

Notes:

- Inventory lots are private to the seller organization.
- Inventory lots are referenced by Marketplace but not owned there.

## Availability

**Availability** is the quantity in an inventory lot that is sellable after reservations are applied.

## Reservation

A **Reservation** is a temporary hold against available inventory created by checkout or other in-progress commerce flows.

## Storage Location

A **Storage Location** is the physical or logical place where a seller stores inventory.

## Ingestion Batch

An **Ingestion Batch** is a bulk import workflow that creates or updates inventory lots.

## Cost Basis

**Cost Basis** is the seller-owned acquisition cost data associated with inventory.
