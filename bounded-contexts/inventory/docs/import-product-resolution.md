# Import Product Resolution

Inventory imports are review-first batches that resolve incoming platform rows to Chase Sets Products before creating account-held stock.

Manual product selection per row is not the intended workflow. Import adapters should capture every stable identifier a source row exposes, then Inventory tries those identifiers against Catalog-owned external references in deterministic order.

## Resolution Flow

1. The import source adapter normalizes CSV, API, or scheduled sync input into Inventory import rows.
2. Each row carries source quantity, price, listing draft fields, seller SKU, row evidence, and ordered external reference candidates.
3. Inventory validates quantity, storage location, listing draft fields, and product resolution.
4. If a native Chase Sets row includes `catalogItemId` and selected `option:<dimensionId>` columns, Inventory resolves the Product directly through the Catalog projection.
5. If a platform row includes external reference candidates, Inventory asks its Catalog projection for each candidate and accepts the first mapped reference.
6. Unmapped rows remain rejected for review instead of forcing per-row manual selection.
7. Committing accepted rows creates or adjusts Inventory Items and may create Marketplace draft Listings through the existing host port.

## Supported CSV Sources

- Chase Sets CSV: native IDs and selected options.
- TCGplayer CSV: tries `tcgplayer:sku:<id>` first, then `tcgplayer:product:<id>`.
- eBay CSV: tries listing ID, variation ID, seller SKU, ePID, GTIN, and UPC namespaces.
- Shopify CSV: tries variant ID, product ID, SKU, barcode, and handle namespaces.
- Whatnot CSV: tries product ID, listing ID, inventory ID, and SKU namespaces.
- CardTrader CSV: tries CardTrader product, blueprint, article, and SKU identifiers, then exposed TCGplayer/Cardmarket identifiers.

API and scheduled sync integrations should produce the same normalized row shape and default to `replace` quantity mode. They should not bypass import review, Inventory availability rules, or Marketplace draft publication rules.

## Review Expectations

Rows should fail review only when:

- no candidate identifier maps to a Catalog Item and, when required by the Product schema, selected Options;
- the mapped Catalog Item is missing, inactive, or has invalid selected Options;
- the row references an invalid or archived Storage Location;
- quantity, price, or listing draft fields violate Inventory or Marketplace preconditions.

Operators or future account mapping tools should resolve grouped misses by creating Catalog Item-level Product ID references, Product-level SKU references, or scoped account SKU mappings. Re-running the same import should then accept those rows without individual product selection.

## Boundaries

- Catalog owns external Catalog Item and Product reference truth.
- Inventory owns import row normalization, resolution status, validation, stock creation, and import review.
- Marketplace owns Listing lifecycle and publication. Imported rows can create drafts only after Inventory has resolved stock.
- Pricing may consume source price evidence later, but imports do not directly mutate Pricing recommendations.

## Pressure Tests

- A TCGplayer SKU miss can still resolve the Catalog Item through Product ID if Catalog has that reference, but selected Options may still be required.
- An eBay title match without a mapped identifier stays in review.
- A Shopify SKU reused by two accounts must not become global product truth without an explicit namespace.
- A replace-mode sync cannot reduce total quantity below active holds.
- Replaying the same accepted import must not create duplicate inventory or draft listing outcomes.
