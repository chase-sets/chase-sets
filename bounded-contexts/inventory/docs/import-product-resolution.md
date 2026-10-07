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

Every source uses the same final Product validity rule: a missing, nonexistent,
inactive, source-mismatched, option-incomplete, or schema-invalid Product stores
`product_id = null` and `resolution_status = unresolved`. Rejected rows from any
provider, plus Saved List location review, feed the same drawer and Seller
Attention predicate.

Explicit `catalogItemId` identity, including Saved List identity, performs no
candidate lookup. Otherwise, check-digit-valid GTINs come first, followed by the
stable source-profile order below. Invalid GTINs are not lookup candidates. A
missing mapping may continue; an ambiguous account SKU or mapped-but-invalid
Product stops, even when a lower-priority candidate would be valid. Titles and
other descriptive evidence never auto-link a Product.

The deterministic `inventory-import-product-resolution-maintenance` job and its
`normalize-legacy-rejected-products-v1` unit repair only rejected, uncommitted
legacy rows. The job's existing durable progress stores an inclusive
`(created_at, row_id)` high-watermark, a microsecond-precise keyset cursor, counts,
and bounded poison diagnostics. Pages contain at most 250 rows. Product writes
and the claim-token-guarded checkpoint share one transaction; a failed page
rolls back both. Claims renew while rows are processed, and guarded row writes
honor `updated_at`, rejection status, commitment, and affected-row counts.

Maintenance validates the persisted Catalog Item, Options, and Product, not
current mappings or other row fields. A missing persisted Product requires
seller confirmation rather than being synthesized from source evidence. Only
`product_id`, `resolution_status`, Product errors, and `updated_at` can change.
Product errors are exactly the Catalog-item missing/inactive/required messages,
the source-Product mismatch message, and messages starting `Selected options `.
All other errors retain their original bytes and relative order.

Three failures poison the retained job and unit without a receipt. Only an
explicit, fenced higher-`validatorVersion` reactivation of the same IDs resumes
the retained high-watermark, cursor, and counts. There are no version-suffixed
jobs or extra receipt tables. A concurrent change is reread; final verification
traverses every rejected/uncommitted row at or below the watermark under row
locks and refuses completion if any Product-state change remains. Such a row is
durably scheduled for revalidation before the next completion attempt.

The one `inventory-import-product-resolution-maintenance/v1` receipt lives in
the existing job result. It includes job/unit/version identity, high-watermark,
final cursor, scanned/normalized/provider/already-converged/concurrent-skip
counts, start/completion instants, and `complete=true`. Counts are cumulative
row inspections and outcomes, including guarded revalidation; no failed page
contributes counts. Retention preserves the job, unit, receipt, and poison event
history. Completed replay returns the same receipt without writes.

`InventoryHostPorts.importProductRollout` can disable new normalization and stock
progression. Review eligibility remains widened even during pre-provider
rollback, partial provider normalization, or after the receipt; native-only
rollback is not retained. New-write validation and widened review eligibility
ship before maintenance and never wait for a receipt. Unresolved rows cannot
create stock or drafts. Manual confirmation replaces the attempt's stale Product
and Option evidence with an active Catalog Item and complete Options, leaving
source evidence intact; accepted/resolved rows leave review. Only native CSV
confirmation with a nonblank SKU persists an account SKU mapping.

## Supported CSV Sources

- Chase Sets CSV: native IDs and selected options, or account-scoped seller SKU mappings when `catalogItemId` is omitted.
- TCGplayer CSV: tries `tcgplayer:sku:<id>` as a Product reference, then `tcgplayer:product:<id>` as a Catalog Item reference. Seller SKU is captured separately as an account SKU candidate when present.
- eBay CSV: valid GTIN/UPC first; then listing and variation Product references, account SKU, and ePID Catalog Item reference.
- Shopify CSV: valid barcode first; then variant Product reference, product Catalog Item reference, account SKU, and handle Catalog Item reference.
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
