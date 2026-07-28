# TCGplayer Automation Client Contract

Catalog TCGplayer ingestion uses the client behavior from
`todd-skelton/tcgplayer-automation-app` at commit `bf42aa8` as its provider
contract. The official TCGplayer API documentation is not the source of truth
for this integration workstream.

This contract exists so Catalog, Inventory, Pricing, and Operations can reuse
the same provider language without turning TCGplayer transport details into
deployable-local behavior.

## Source Application Evidence

The reviewed automation app exposes these integration seams:

- `app/core/clients/baseDomainClient.server.ts`
- `app/core/config/httpConfig.shared.ts`
- `app/core/clients/mpSearchApi.client.server.ts`
- `app/core/clients/mpApi.client.server.ts`
- `app/core/clients/infiniteApi.client.server.ts`
- `app/core/clients/mpGateway.client.server.ts`
- `app/integrations/tcgplayer/client/*`
- `app/routes/home.server.ts`
- `db/migrations/001_create_tables.sql`

The source app's local tables are not Chase Sets target schemas. They describe
provider concepts that Chase Sets maps into bounded-context-owned facts.

## Provider Domains

The automation client uses one configured user agent and a
`TCGAuthTicket_Production` cookie across provider-domain clients.

| Domain key | Host | Primary use |
| --- | --- | --- |
| `mpSearchApi` | `mp-search-api.tcgplayer.com` | Product lines, product search, product details, product listings, category filters. |
| `mpApi` | `mpapi.tcgplayer.com` | Catalog set names and latest sales. |
| `infiniteApi` | `infinite-api.tcgplayer.com` | Price-guide set cards and price history. |
| `mpGateway` | `mpgateway.tcgplayer.com` | SKU market price points. |
| `orderManagementApi` | `order-management-api.tcgplayer.com` | Seller order lookup and tracking workflows; not Catalog ingestion. |
| `messagesApi` | `messages-api.tcgplayer.com` | Seller order message workflows; not Catalog ingestion. |

Catalog import should start with the first four domains. Order and message
domains are operations/fulfillment evidence for future workflows and must not be
pulled into Catalog.

## Authentication And Throttling

The automation client sends:

- `User-Agent` from provider HTTP configuration.
- `Cookie: TCGAuthTicket_Production=<cookie>;` when a cookie is configured.
- `Cache-Control: no-cache`.
- `Content-Type: application/json`.

Requests use domain-scoped throttling:

- maximum concurrent requests per domain;
- minimum delay between request starts;
- cooldown after rate limits;
- retry on `403`, `429`, `502`, `503`, and `504`;
- adaptive delay increase on rate limit;
- adaptive delay decrease after a success streak;
- learned minimum delay that ratchets upward after rate limits.

Chase Sets must keep the cookie out of event payloads, logs, Source
Observations, and committed config. Operational state such as learned delays can
be persisted in a provider operations store, but secret material cannot.

## Catalog Sync Flow

The automation app's `home.server.ts` defines the catalog hydration flow that
Chase Sets should model as durable provider import jobs:

1. Fetch all product lines from `mpSearchApi`.
2. For one product line/category, fetch catalog set names from `mpApi`.
3. For each set name, search products in that product line and set through
   `mpSearchApi`.
4. For each provider product, fetch product details from `mpSearchApi`.
5. Hydrate SKUs from the product detail response.
6. Detect provider set reclassification when an already-known product reports a
   different set in product details.

Chase Sets does not upsert provider products directly into Catalog Items during
this flow. The flow records Source Observations and external-reference evidence.
Promotion remains a Catalog review action.

## Catalog Provider Endpoints

These endpoints are the automation-app contract for Catalog-facing ingestion.

| Client | Method and path | Chase Sets use |
| --- | --- | --- |
| `mpSearchApi` | `GET /v1/search/productLines` | Provider option query for product line/category scopes. |
| `mpApi` | `GET /v2/Catalog/SetNames?categoryId={categoryId}` | Provider option query and import scope for set names. |
| `mpSearchApi` | `GET /v1/product/categoryfilters?categoryId={categoryId}` | Provider option evidence for condition, variant/printing, and language mappings. |
| `mpSearchApi` | `POST /v1/search/request` | Product discovery inside product line and set-name scopes. |
| `mpSearchApi` | `GET /v2/product/{id}/details` | Product detail and SKU hydration. |
| `infiniteApi` | `GET /priceguide/set/{setId}/cards/?rows={rows}` | Secondary set-card evidence; do not treat price fields as Catalog truth. |

The product search body used by the app filters by `productLineName` and
`setName`, sorts by `product-sorting-name`, and pages with `from` and `size`.
The app caps search page size at `24`.

## Response Shape Audit

The automation app's TypeScript response types describe the app workflow, not a
complete Catalog DTO contract. Catalog keeps sanitized representative fixtures
and field-ownership decisions in:

- `bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-response-fixtures.test-data.ts`
- `bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-response-contract.ts`

Those fixtures cover product lines, catalog set names, product search, and
product detail/SKU hydration. Future import mapping must expand DTOs from those
fixtures before new provider fields affect observation identity, merge
confidence, external references, or promotion.

Response fields are classified as Catalog truth, Catalog merge evidence,
external reference evidence, Pricing signal, Inventory signal, operations
diagnostic, or excluded data. Only Catalog truth, merge evidence, and external
reference evidence may affect Catalog Source Observation hashes. Price, listing,
seller, seller quantity, and sales fields remain source-payload evidence or
handoff signals and must not become Catalog truth.

Product detail currently proves SKU, condition, variant/printing, and language.
`productConditionId` appears in listing/search evidence, not in product-detail
SKU evidence. Catalog can create `tcgplayer:sku:<id>` Product references from
product-detail SKUs when selected options are valid, but must only map
`productConditionId` after a fixture-backed endpoint proves the value is
available in that flow.

## Pricing Provider Endpoints

These endpoints are not Catalog truth. They belong to a Pricing-owned Price
Signal path once Catalog can resolve TCGplayer SKUs to Chase Sets Products.
Pricing's ingestion boundary, signal shape, and algorithm decisions for these
endpoints are documented in
[TCGplayer Price Signals](../../pricing/docs/tcgplayer-price-signals.md).

| Client | Method and path | Pricing use |
| --- | --- | --- |
| `mpGateway` | `POST /v1/pricepoints/marketprice/skus/search` | Market, low, high, and count evidence by SKU. |
| `mpApi` | `POST /v2/product/{id}/latestsales` | Latest sale evidence by product, filtered by condition, language, variant, and listing type. |
| `mpSearchApi` | `POST /v1/product/{id}/listings` | Active supply evidence and listing aggregation. |
| `infiniteApi` | `GET /price/history/{id}/detailed?range={range}` | Price-history buckets and velocity evidence. |

Catalog Source Observation payloads and hashes must exclude price, sale,
listing, and buylist values. Pricing can store those values in Pricing-owned
read models or event streams.

## Provider Concepts

### Product Line

The automation app stores product lines with:

- `productLineId`
- `productLineName`
- `productLineUrlName`
- `isDirect`

Catalog maps product lines to provider option scopes and, where useful, Product
Line Reference Records. Product lines do not create Products.

### Category Set

The automation app calls TCGplayer set names `category_sets` locally. Each set
name carries:

- `setNameId`
- `categoryId`
- `name`
- `cleanSetName`
- `urlName`
- `abbreviation`
- `releaseDate`
- `isSupplemental`
- `active`

Catalog maps these to set or expansion reference evidence when the product line
has set-like structure.

### Product

TCGplayer product IDs identify provider product pages or card-print records.
They map to External Catalog Item References:

```json
{ "providerKey": "tcgplayer", "externalKey": "product:12345" }
```

Product details include product type, rarity, sealed flag, product name, set
identity, product line identity, status, attributes, and SKUs. Product details
can refresh an existing Source Observation into `changed` when TCGplayer moves a
product to another set.

### SKU

The automation app models `sku` as the sellable TCGplayer identity for one
condition, variant/printing, and language. Listing APIs also expose
`productConditionId`; Chase Sets treats that value as the same SKU-level
provider identity when it represents the sellable condition/variant/language.

TCGplayer SKU IDs map to External Product References only when selected options
resolve to active Catalog Product schema options:

```json
{
  "providerKey": "tcgplayer",
  "externalKey": "sku:987654",
  "selectedOptions": [
    { "dimensionId": "dim_condition", "optionId": "opt_near_mint" },
    { "dimensionId": "dim_printing", "optionId": "opt_holofoil" },
    { "dimensionId": "dim_language", "optionId": "opt_english" }
  ]
}
```

Unknown conditions, variants, languages, sealed forms, or values for dimensions
that are not currently part of the Product schema remain review evidence on the
Source Observation SKU reference. They must not create invalid Product
references.

Selected-option resolution is configured in the Catalog-owned TCGplayer provider
profile. The profile supplies provider evidence paths, alias mappings,
requiredness, and sealed/unsealed product-form mappings; runtime resolution
still validates the result against the active Product schema before emitting a
SKU-level external Product reference.

## Ownership Mapping

| Provider evidence | Owning Chase Sets context | Policy |
| --- | --- | --- |
| Product line, set name, product details, images | Catalog | Reviewable Source Observations and promoted Catalog facts. |
| Product ID | Catalog | External Catalog Item Reference: `tcgplayer:product:<id>`. |
| SKU/productConditionId | Catalog | External Product Reference: `tcgplayer:sku:<id>` with valid selected options. |
| Seller inventory quantities and seller SKU | Inventory | Import row evidence and account-held stock; not global Catalog truth. |
| Active listings and seller supply | Pricing or Marketplace, depending on workflow | Pricing signals or Marketplace facts; not Catalog truth. |
| Market price, latest sales, price history | Pricing | Price Signals after SKU-to-Product resolution. |
| Orders, tracking, messages | Ordering, Fulfillment, Notifications, or Support | Future operational integrations; not Catalog ingestion. |

## Duplicate Prevention

TCGplayer Product IDs are high-priority merge evidence. Promotion should reuse
an existing non-archived Catalog Item when any provider has already linked the
same `tcgplayer:product:<id>` reference.

When no exact external reference exists, promotion may propose deterministic
merge candidates from product line, set name, card number, normalized product
name, variant/printing, and language. Candidate evidence is review-only when it
is not unique.

Sealed TCGplayer products must not reuse single-card deterministic identity.
Their merge identity uses product line, set/group, normalized product name,
product form, language, and barcode/GTIN/UPC when the automation response
provides it. A sealed product without an exact external reference or unique
sealed-product identity stays in review rather than creating an automatic match.

Replaying the same import must not duplicate Source Observations, Catalog Items,
external catalog item references, or external product references.

## Operational Boundaries

- Provider cookies are secrets.
- Provider request and response payloads may contain seller or marketplace data
  that is not Catalog truth.
- Live provider failures should be durable job outcomes with enough detail for
  operators and no secret leakage.
- Long imports should checkpoint after durable writes so deployment transitions
  continue from recorded work rather than restarting the whole provider scope.
