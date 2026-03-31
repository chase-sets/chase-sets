# Inventory Domain Glossary

This glossary defines the canonical terminology for the Inventory bounded context.

## Inventory Record

An **Inventory Record** is a seller's stock for one specific catalog item, condition, and storage location.

Notes:

- Every inventory record belongs to exactly one seller account.
- Every inventory record belongs to exactly one storage location.
- Marketplace may reference inventory availability, but Inventory owns the stock truth.

## Total Quantity

**Total Quantity** is the number of units recorded in an inventory record before active holds are applied.

## Available Quantity

**Available Quantity** is the number of units in an inventory record that can still be sold after active holds are applied.

## Hold

A **Hold** is a temporary block against available stock while checkout or another in-progress commerce flow completes.

## Storage Location

A **Storage Location** is a seller-defined place where stock is stored.

Notes:

- A seller account may have more than one storage location.
- A storage location may be as broad as a room or as granular as a bin, shelf, or aisle.
- Each storage location maps to exactly one ship-from location.

## Import

An **Import** is a bulk inventory upload that creates or updates inventory records.

## Acquisition Cost

**Acquisition Cost** is the seller's recorded cost to acquire stock in inventory.
