# External Product References

Catalog owns external catalog item references and external product references because both map third-party product identity into Chase Sets Catalog truth at different levels.

An external catalog item reference links one provider-owned product/card-print identifier to one Catalog Item. For TCGplayer, this is the Product ID: it identifies the provider product page or card print, but it does not identify a Chase Sets Product by itself.

An external product reference links one provider-owned SKU or sellable identifier to one Catalog Item plus the selected Options needed to resolve the Product. For TCGplayer, this is the SKU ID because a SKU can encode sellable choices such as condition, printing, finish, or language.

Downstream contexts consume these references as published Catalog facts; they do not decide provider product identity themselves.

## Reference Shape

Each reference is scoped by:

- `providerKey`
- `externalKey`
- `selectedOptions` for external product references only

The `externalKey` should include a natural namespace when the provider exposes multiple identifier classes. Examples:

- `tcgplayer` + `product:12345` as an external catalog item reference
- `tcgplayer` + `sku:987654` as an external product reference
- `ebay` + `listing:2001`
- `ebay` + `sku:box-a-001`
- `shopify` + `variant:987`
- `shopify` + `barcode:012345678905`
- `whatnot` + `product:prod_1`
- `cardtrader` + `blueprint:ct_bp_1`
- `cardmarket` + `product:67890`

## Matching Policy

Provider integrations and import adapters should prefer stable provider identifiers over title parsing:

1. Provider SKU identifiers that already encode condition/printing/finish and can map to selected Options.
2. Provider product identifiers as Catalog Item references, paired with selected Options from another trusted source before becoming Product references.
3. Barcode, GTIN, UPC, ePID, or platform catalog IDs for sealed and broader retail products.
4. Account-owned SKUs only after an account or operator confirms the mapping.
5. Composite title, set, card number, language, finish, and condition evidence only as review evidence until promoted into an explicit reference.

## Update Paths

Provider sync jobs may add or refresh Source Observations, provider integration profile data, external catalog item references, and external product references. TCGplayer imports retain every SKU as review evidence, but they publish SKU-level external product references only after the provider condition, printing, language, and product form evidence resolves to active Catalog Product schema options. They must not write Inventory Items or Marketplace Listings directly.

Inventory import and sync adapters consume the Catalog projection of external references. If a provider export row carries multiple identifiers, Inventory may try each candidate in adapter order and use the first Catalog-owned reference that resolves. A Product-level SKU reference can resolve selected Options directly. A Catalog Item-level Product ID reference can resolve only the Catalog Item; the row still needs selected Options or a later review path when the Catalog Item's Product schema requires options.

## GTIN Lookup

A GTIN (barcode) is not a provider external reference: no single provider owns it, and it needs its own normalization (GTIN-8/12/13/14 collapse to a canonical 14-digit form) and GS1 check-digit validation before it can be trusted as a lookup key. Catalog Items therefore link GTINs through a dedicated mechanism (`LinkCatalogItemGtin` / `UnlinkCatalogItemGtin`), not through `LinkExternalCatalogItemReference` with a synthetic `providerKey`. The catalog projection maintains a `gtin -> catalog item (+ product form)` read model, UNIQUE on the normalized GTIN, queryable via `getCatalogItemByGtin`. Inventory mirrors the same facts (`catalog.catalog-item.gtin-linked` / `-unlinked`) into its own read model so import resolution and a future camera-scan seller-intake flow can resolve a scanned barcode without round-tripping through Catalog.

Inventory import wiring: a `barcode`/`gtin`/`upc` column resolves through the GTIN lookup before falling back to account-owned SKU mappings or other provider-scoped candidates -- a scanned barcode is a global, check-digit-validated identifier and should win over a looser SKU guess.

## Pressure Tests

- Replaying a Catalog external-reference event must keep Inventory resolution deterministic.
- Removing a reference must stop future imports from resolving through that identifier after projections catch up.
- A provider SKU collision must remain scoped by `providerKey`.
- Account-owned SKUs must not become global Catalog truth without an explicit provider/account namespace.
- A TCGplayer Product ID must not be treated as a TCGplayer SKU.
- A TCGplayer SKU must not be treated as a Catalog Item-level product page mapping.
- Title parsing must never silently publish Catalog truth; it can only produce review evidence.
- A GTIN must remain unique across the whole Catalog; it is never provider-scoped like other external references.
