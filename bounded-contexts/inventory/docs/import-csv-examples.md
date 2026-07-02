# Inventory CSV Import Examples

Inventory imports use a review-first batch. Rows are validated before they create or adjust stock.

## Chase Sets CSV

Use this when the file already contains Chase Sets catalog identifiers and storage location names.

```csv
catalogItemId,storageLocation,totalQuantity,option:form,option:condition,listingPriceAmount,listingQuantityCap,rowNote
cat_seed_charizard_base_set,Main shelf,2,Raw,Near Mint,125.00,1,Base Set restock
```

Use `storageLocation` for the visible active storage location name. `storageLocationId` is still accepted when an exported file already contains internal Chase Sets storage identifiers.

Option columns may use Catalog dimension ids or visible dimension labels. Option values may use option ids, codes, or visible labels.

## TCGplayer CSV

Use this when importing a TCGplayer inventory export. The importer resolves `TCGplayer SKU` first, then falls back to `Product ID`.

```csv
TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Seller SKU
tcg_sku_1,Charizard,Base Set,Near Mint,2,125.00,box-a-001
tcg_sku_pikachu_jungle_nm,Pikachu,Jungle,Near Mint,5,8.50,box-a-002
```

`TCGplayer SKU` maps to a Chase Sets product, including the selected options. `Product ID` maps only to the Catalog Item, so rows resolved by Product ID still need option values from the file or review before they can become inventory.

## Quantity Modes

- `add` treats `totalQuantity` as a signed adjustment.
- `replace` treats `totalQuantity` as the exact stock count to sync to.

Sync adapters should produce the same normalized row shape as CSV adapters and default to `replace`.
