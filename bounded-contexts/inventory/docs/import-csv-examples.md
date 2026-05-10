# Inventory CSV Import Examples

Inventory imports use a review-first batch. Rows are validated before they create or adjust stock.

## Chase Sets CSV

Use this when the file already contains Chase Sets catalog and storage identifiers.

```csv
catalogItemId,storageLocationId,totalQuantity,option:dim_seed_form,option:dim_seed_condition,listingPriceAmount,listingQuantityCap,rowNote
cat_seed_charizard_base_set,loc_seed_main,2,chc_seed_form_raw,chc_seed_condition_near_mint,125.00,1,Base Set restock
```

## TCGplayer CSV

Use this when importing a TCGplayer inventory export. The importer resolves `TCGplayer SKU` first, then `Product ID`.

```csv
TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Seller SKU
tcg_sku_1,Charizard,Base Set,Near Mint,2,125.00,box-a-001
tcg_sku_pikachu_jungle_nm,Pikachu,Jungle,Near Mint,5,8.50,box-a-002
```

Unmapped TCGplayer rows are rejected for review until Catalog links the external reference to a Chase Sets catalog item and selected options.

## Quantity Modes

- `add` treats `totalQuantity` as a signed adjustment.
- `replace` treats `totalQuantity` as the exact stock count to sync to.

Sync adapters should produce the same normalized row shape as CSV adapters and default to `replace`.
