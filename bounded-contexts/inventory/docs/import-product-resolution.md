# Import Product Resolution

Inventory imports are review-first batches that resolve incoming platform rows to Chase Sets Products before creating account-held stock.

Manual product selection per row is not the intended workflow. Import adapters should capture every stable identifier a source row exposes, then Inventory tries those identifiers against Catalog-owned external references in deterministic order.

## Resolution Flow

1. The import source profile defines the file/API kind, header aliases, field mappings, ordered external reference candidates, target intent, and selected option inference rules.
2. The small connector parses CSV or fetches provider rows, then the profile-driven adapter normalizes that input into Inventory import rows.
3. Each row carries source quantity, price, listing draft fields, seller SKU, row evidence, selected option candidates, and ordered external reference candidates.
4. Inventory validates quantity, storage location, listing draft fields, and product resolution.
5. If a native Chase Sets row includes `catalogItemId` and selected `option:<dimensionId>` or `option:<dimension label>` columns, Inventory resolves the Product directly through the Catalog projection.
6. If a native Chase Sets row omits `catalogItemId` but includes `sellerSku` or `Seller SKU`, Inventory resolves that seller SKU through Inventory-owned account-scoped SKU mappings.
7. If a platform row includes external reference candidates, Inventory follows each candidate's target intent. Product-reference candidates check Catalog Product references; Catalog Item-reference candidates check Catalog Item references; account SKU candidates check Inventory-owned account SKU mappings for the importing account and are not treated as global Catalog truth.
8. Unmapped rows remain rejected for review instead of forcing per-row manual selection.
9. Committing accepted rows creates or adjusts Inventory Items and may create Marketplace draft Listings through the existing host port.

## Supported CSV Sources

- Chase Sets CSV: native IDs and selected options, or account-scoped seller SKU mappings when `catalogItemId` is omitted.
- TCGplayer CSV: tries `tcgplayer:sku:<id>` as a Product reference, then `tcgplayer:product:<id>` as a Catalog Item reference. Seller SKU is captured separately as an account SKU candidate when present.
- eBay CSV: tries listing and variation identifiers as Product references, seller SKU as an account SKU candidate, then ePID, GTIN, and UPC as Catalog Item candidates.
- Shopify CSV: tries variant ID as a Product reference, product ID/barcode/handle as Catalog Item candidates, and SKU as an account SKU candidate.
- Whatnot CSV: tries product ID as a Catalog Item candidate, listing and inventory IDs as Product references, and SKU as an account SKU candidate.
- CardTrader CSV: tries CardTrader product and blueprint identifiers as Catalog Item candidates, article identifiers as Product references, SKU as an account SKU candidate, then exposed TCGplayer/Cardmarket Product IDs as Catalog Item candidates.

API, MCP, and scheduled sync integrations should produce the same normalized row shape and default to `replace` quantity mode. Shopify, eBay, and other API connectors should fetch provider rows only; the source profile decides header aliases, field meaning, option inference, reference ordering, and target intent. They should not bypass import review, Inventory availability rules, or Marketplace draft publication rules.

Agent listing integration flow is documented in [Agent Listing Integrations](./agent-listing-integrations.md).

## Review Expectations

Rows should fail review only when:

- no candidate identifier maps to a Catalog Item and, when required by the Product schema, selected Options;
- the mapped Catalog Item is missing, inactive, or has invalid selected Options;
- the row references an invalid or archived Storage Location;
- quantity, price, or listing draft fields violate Inventory or Marketplace preconditions.

Operators or future account mapping tools should resolve grouped misses by creating Catalog Item-level Product ID references, Product-level SKU references, or scoped account SKU mappings. Re-running the same import should then accept those rows without individual product selection.

Inventory account SKU mappings are intentionally account scoped. A Shopify SKU, eBay custom label, TCGplayer seller SKU, or native CSV `sellerSku` can mean different Products for different seller accounts. The mapping stores the importing account, normalized seller SKU, `catalogItemId`, and selected options. A row with no mapping stays rejected for review; a row with duplicate mappings for the same account and normalized SKU is rejected as ambiguous rather than choosing one target.

## Boundaries

- Catalog owns external Catalog Item and Product reference truth.
- Inventory owns import row normalization, account SKU mappings, resolution status, validation, stock creation, and import review.
- Marketplace owns Listing lifecycle and publication. Imported rows can create drafts only after Inventory has resolved stock.
- Pricing may consume source price evidence later, but imports do not directly mutate Pricing recommendations.

## Pressure Tests

- A TCGplayer SKU miss can still resolve the Catalog Item through Product ID if Catalog has that reference, but selected Options may still be required.
- An eBay title match without a mapped identifier stays in review.
- A Shopify SKU reused by two accounts must not become global product truth without an explicit namespace.
- A native `Seller SKU` reused by two accounts resolves only through the importing account's mapping.
- Duplicate mappings for one account and SKU fail review so stock is not silently assigned to the wrong Product.
- A replace-mode sync cannot reduce total quantity below active holds.
- Replaying the same accepted import must not create duplicate inventory or draft listing outcomes.
