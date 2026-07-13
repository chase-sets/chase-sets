# ADR 0007: Google Shopping Merchant Center Integration

## Status

Accepted

## Context

Chase Sets wants Google Shopping and free-listing distribution for public marketplace listings without collapsing bounded-context ownership. The repo already fixes source ownership:

- Catalog owns Catalog Item, Product, selected Options, display templates, Product Asset Sets, external product references, and Resolved Product Measures.
- Marketplace owns Listing lifecycle, price, quantity cap, visibility, and Seller Listing Availability.
- Discovery owns public browse/search/detail, public listing routes, canonical marketplace URLs, sitemap posture, and public market projections.
- Identity owns Account identity and Account lifecycle facts.
- Ordering owns Shipping Quote Policy; Fulfillment owns shipment execution; Public Presence owns public policy pages; Tax owns tax readiness.

Google Merchant API separates submitted data from processed product state: writes use `productInputs`, while processed status is read through product/status resources. API writes require an API data source in Merchant Center. Google also expects regular refreshes, complete product and policy data, crawlable landing pages, and marketplace seller handling through multi-seller account structure and `external_seller_id` when Chase Sets submits offers for many sellers.

## Decision

Chase Sets will launch Google Shopping as a Discovery-owned public export projection over source facts owned by Catalog, Marketplace, Identity, Ordering, Fulfillment, Public Presence, Tax, and Reputation. Platform Runtime will compose worker configuration, scheduling, and provider calls, but it will not own Google-facing business facts.

The first launch targets Google's marketplace/multi-seller account model. Submitted rows include an `external_seller_id` derived from Chase Sets Account identity. If Google approval or account conversion is not ready, production submission stays launch-blocked or dry-run-only; the implementation will not silently switch to a single-seller data model.

Google rows are listing-level rows. A Catalog Product alone does not contain listing price, quantity, seller availability, or a listing landing page. A Marketplace Listing does, so one public active listing maps to one Google offer row.

## Row Identity

The Merchant offer id is derived from immutable Listing identity:

- Row id: `google-shopping:listing:<listing_id>`
- Merchant offer id: `cs-listing-<listing_id>`
- External seller id: `cs-account-<account_id>`

Display text, price, seller display name, slugs, and URLs may change without changing row identity.

## Field Ownership

| Google-facing field | Owner | Export source |
| --- | --- | --- |
| `id` / Merchant offer id | Discovery projection over Marketplace Listing identity | Stable `listing_id` |
| `external_seller_id` | Identity owns Account; Discovery exports the stable reference | `account_id` projected into public market rows |
| `title` | Catalog owns source display title policy | Catalog display template/title projected into Discovery |
| `description` | Catalog owns item facts; Discovery owns public presentation text | Catalog facts projected into Discovery detail/search copy |
| `link` | Discovery | Canonical public listing URL |
| `image_link` | Catalog owns normalized assets; Discovery selects public image | Product Asset Set or Catalog image fallback |
| `price` | Marketplace | Listing price snapshot |
| `availability` | Marketplace and Discovery | Active Listing, available seller, quantity cap, and public visibility |
| `condition` | Catalog | Product selected Options when condition is modeled as a Dimension |
| `brand`, `gtin`, `mpn`, identifiers | Catalog | Canonical fields/references only; parsed provider evidence is not product truth |
| `shipping` | Ordering, Fulfillment, Catalog | Ordering policy using Catalog measures and Fulfillment/ship-from facts |
| `return_policy_label` or returns mapping | Public Presence and Ops | Public policy page plus Merchant Center configuration |
| `tax` / tax readiness | Tax | Tax readiness posture; order tax snapshots stay in Ordering |
| Diagnostics/status | Discovery export state; Ops owns response | Merchant processed status and issues correlated to row identity |

## Projection Strategy

Discovery owns `discovery_google_shopping_feed_rows`. Rows materialize:

- stable row/listing/account/product references,
- Merchant offer id and external seller id,
- canonical URL and payload hash,
- eligibility status and exclusion reasons,
- last-submitted payload hash and submission timestamps,
- processed diagnostic status and issues,
- tombstone/delete state for rows that must be withdrawn.

Eligibility is explainable and testable. A row is excluded when the listing is inactive, seller availability is off, landing page is not crawlable, title/description/image/price/condition/policy facts are missing, or the row has been tombstoned for withdrawal.

## Worker And Configuration

Platform Worker owns runtime configuration and disabled-by-default safety:

- `GOOGLE_MERCHANT_SYNC_ENABLED`
- `GOOGLE_MERCHANT_DRY_RUN`
- `GOOGLE_MERCHANT_ACCOUNT_ID`
- `GOOGLE_MERCHANT_API_DATA_SOURCE_ID`
- `GOOGLE_MERCHANT_TARGET_COUNTRY`
- `GOOGLE_MERCHANT_CONTENT_LANGUAGE`
- `GOOGLE_MERCHANT_FEED_LABEL`
- `GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME`
- `GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE`

When sync is enabled, missing or malformed config fails startup. Logs may describe whether credentials are configured but must not print credential JSON, private keys, OAuth tokens, or raw provider secrets. When `GOOGLE_MERCHANT_DRY_RUN=false`, startup additionally fails unless `GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE` is a real, non-placeholder evidence reference, so live Merchant writes cannot be enabled by config alone without a recorded approval.

## Launch Exclusions

This ADR does not launch:

- paid Shopping ads,
- promotions feed submission,
- local inventory ads,
- reviews feed submission,
- order-tracking signals,
- automated seller policy appeal workflows,
- provider diagnostics UI beyond the export/sync state needed by later milestone issues.

## Consequences

The model keeps source ownership stable and makes Google Shopping a projection/sync concern instead of a new aggregate owner. It also means launch readiness depends on external Google account approval, Merchant API data-source setup, public crawlability, policy pages, shipping/returns mapping, and diagnostics ingestion before production submission can be enabled.
