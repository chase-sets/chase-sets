# Inventory CSV Import Examples

Inventory imports use a review-first batch. Rows are validated before they create or adjust stock.

## Recovery And Privacy

An upload receives a durable validation job, not a synchronous stock change. Inventory stores only a versioned, hashed snapshot of recognized import fields in pages of at most 100 rows. It does not retain the uploaded file, its filename, unknown columns, or raw CSV. Do not put credentials, URLs, private paths, or secrets in import fields.

Keep the original file until review is complete. The pre-commit resume window is 24 hours from acceptance. Active validation or commit work is not expired. After the window, an inactive, uncommitted batch expires and its source is removed by exact snapshot identity. Original row diagnostics, the cleanup audit, and the first acceptance receipt remain available. Expired batches cannot commit; reselect the source for a new import.

After a lost response, return with the original account and acting User. The browser restores only an opaque attempt identity and reads its private result; it never restores or resends the file. An uncertain result disables another upload until the original result is confirmed or explicitly discarded after checking for accepted work. Signing in as another User or switching accounts does not authorize the saved attempt.

### Safe Snapshot Rollout

The schema ledger installs the additive snapshot tables and reader columns before new writers use them. The compatible reader converts retained CSV, parsed, or normalized-row work transactionally without revalidating its original admission. Once the safe-snapshot release is the rollback floor, one ledgered schema migration contracts the raw sources during schema bootstrap. Under the import cutover lock it converts any remaining legacy input and queued normalized-row work, re-sanitizes every retained raw row, job result and event snapshot, and then drops the raw-source columns, all in one transaction. History already in the safe shape is left as stored. A failure anywhere rolls the whole migration back with its ledger row, and the next bootstrap retries it; a lock timeout is retried by bootstrap. The ledger row makes the contraction run once per database: later bootstraps skip it and import-worker polls never contract. Repeated schema bootstrap never recreates retired columns.

New writers use the fenced `create-snapshot-v1` job and work-unit kind. New workers claim that kind plus legacy `create`, while base workers claim only `create` and `commit`; a base worker therefore ignores new work during a rolling update. Conversion moves queued legacy jobs and units to the fenced kind in the same transaction. Rollback to the floor release is safe: its own contraction returns early once the raw columns are gone, and its projections read a null source filename rather than the column. Rollback below the floor is unsupported, because base writers need the dropped columns. Import lists, details and Seller Desk attention items reference a batch by its id. No operator quiesce is required. A source that cannot be converted safely fails closed for audited same-identity reconciliation. The worker resumes the original job and immutable row outcomes, never a new batch identity.

## Chase Sets CSV

Use this when the file already contains Chase Sets catalog identifiers and storage location names. Sellers can download a native template from the Inventory import page. The template includes the required native headers and one example row for each active storage location on that account. Archived storage locations are not included.

Sellers can also export current inventory from the Inventory import page. That export uses the same native import headers, includes the account's current `catalogItemId`, `storageLocationId`, selected option columns, `totalQuantity`, and acquisition cost when available, and can be edited and uploaded again without typing Chase Sets internal identifiers.

```csv
catalogItemId,storageLocation,totalQuantity,option:form,option:condition,acquisitionCostAmount,acquisitionCostCurrencyCode,sellerSku,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap,rowNote
cat_seed_charizard_base_set,Main shelf,2,Raw,Near Mint,75.00,USD,box-a-001,125.00,USD,1,Base Set restock
```

Use `storageLocation` for the visible active storage location name. `storageLocationId` is still accepted and is what the current-inventory export uses so reuploads target the exact same storage location.

Option columns may use Catalog dimension ids or visible dimension labels. Option values may use option ids, codes, or visible labels.

`acquisitionCostAmount` and `acquisitionCostCurrencyCode` are optional, but must be supplied together. The currency is the seller-authored uppercase three-letter acquisition denomination; imports do not infer or convert it.

If an account SKU mapping already exists, native rows may use `sellerSku` or `Seller SKU` without a `catalogItemId`. Seller SKU mappings are owned by Inventory and scoped to the importing account, so the same SKU text can safely map to different Products for different sellers. Unknown or duplicate mappings stay in import review.

```csv
Seller SKU,storageLocation,totalQuantity,acquisitionCostAmount,acquisitionCostCurrencyCode,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap,rowNote
box-a-001,Main shelf,2,75.00,USD,125.00,USD,1,Restock by account SKU
```

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

Current-inventory exports contain exact stock counts. Use `replace` when reuploading an edited export for repricing or restock sync; use `add` only when the rows are intentional stock adjustments.

Sync adapters should produce the same normalized row shape as CSV adapters and default to `replace`.
