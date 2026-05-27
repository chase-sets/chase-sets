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

## External Reference Candidate

An **External Reference Candidate** is a provider-scoped identifier captured from an import row before Inventory resolves it to a Chase Sets Product.

Notes:

- Examples include a TCGplayer SKU, eBay listing ID, Shopify variant ID, Whatnot product ID, CardTrader blueprint ID, or barcode.
- Inventory tries candidates in adapter order and accepts the first mapped Catalog External Product Reference.
- External Reference Candidates are row evidence, not Inventory-owned product truth.

## Acquisition Cost

**Acquisition Cost** is the seller's recorded cost to acquire stock in inventory.
