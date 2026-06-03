# Google Shopping Feed Mapping

Discovery owns the Google Shopping export row as a public marketplace projection. It does not own Catalog, Marketplace, Ordering, Fulfillment, Public Presence, or Tax facts. This document defines how Discovery maps those published facts into Google-facing row attributes.

This mapping follows [ADR 0007](../../../docs/adr/0007-google-shopping-merchant-center-integration.md): one active public Marketplace Listing maps to one Google row.

## Source Ownership

| Google-facing concern | Source owner | Mapping rule |
| --- | --- | --- |
| Row id and Merchant offer id | Discovery projection over Marketplace Listing identity | Derive from immutable `listing_id`: `google-shopping:listing:<listing_id>` and `cs-listing-<listing_id>`. |
| External seller id | Identity account identity projected through Discovery | Derive from `account_id`: `cs-account-<account_id>`. |
| Title | Catalog | Use Catalog display title and subtitle projected into Discovery. Do not parse provider titles as canonical truth. |
| Description | Catalog, projected through Discovery presentation | Prefer Catalog description. Use product summary only as a fallback when it is already a published product-selection summary. |
| Product details | Catalog | Map selected Options into Google product details using dimension and option labels when available. |
| Brand, GTIN, MPN, product type, Google category | Catalog | Include only explicit Catalog fields or reference-derived facts. Missing identifiers are not inferred from provider evidence. |
| Image | Catalog | Prefer Product Asset Set `catalog-detail` WebP variants. Compatibility image URLs are fallback candidates only when absolute and public. |
| Listing price and availability | Marketplace | Use active Listing price, quantity cap, lifecycle status, and Seller Listing Availability. |
| Landing link | Discovery | Use the canonical public listing URL, not an item detail URL, so price and availability match the submitted row. |
| Shipping readiness | Ordering, Fulfillment, Catalog | Launch uses Merchant Center account-level shipping settings plus row-level readiness evidence from ship-from, shipping allowance, and product measure posture. |
| Returns readiness | Public Presence and operations | Use the public `/refunds-and-returns` policy URL and a Merchant Center return policy label when reviewed. |
| Tax posture | Tax and Ordering | Do not submit row-level tax attributes in this slice. Launch evidence must confirm Google-facing tax posture does not contradict checkout. |

## Eligibility

A row is eligible only when every required product, offer, image, policy, and crawlability input is present.

Discovery records all applicable exclusion reasons so operators can remediate rows without guessing. Current reasons include:

- `listing-not-active`
- `seller-unavailable`
- `seller-not-active`
- `sold-out`
- `missing-link`
- `missing-title`
- `missing-description`
- `missing-image`
- `invalid-image-url`
- `image-not-public`
- `image-too-small`
- `fallback-image-not-approved`
- `missing-price`
- `missing-condition`
- `ambiguous-condition`
- `missing-shipping-policy`
- `missing-returns-policy`
- `missing-product-measure`
- `not-crawlable`

Rows with any exclusion reason are not submitted as live product inputs. Later sync jobs may use tombstones to withdraw previously submitted rows when source facts become ineligible.

## Catalog Product Mapping

Catalog display templates are the source of launch titles and subtitles. The Google title is the non-empty Catalog title plus subtitle when present. The description uses the Catalog description, falling back to the published product summary only when the description is empty.

Selected Options become Google product details. For example, a selected `Condition: Near Mint` and `Finish: Holofoil` can be submitted as product details, while still keeping `condition` itself mapped through the policy below.

Identifier policy is conservative:

- Include `gtin`, `mpn`, and `brand` only when they are explicit Catalog facts.
- Set `identifier_exists=false` for trading-card rows without canonical identifiers.
- Never turn unaccepted source observations, title parsing, seller notes, or provider listing evidence into canonical identifiers.

## Condition Policy

Google condition values are simpler than trading-card condition language. Chase Sets maps them conservatively:

| Chase Sets product condition/form | Google `condition` | Notes |
| --- | --- | --- |
| Sealed, unopened, factory sealed, or explicitly new product selection | `new` | Requires explicit Catalog Product selection or product form evidence. |
| Pristine, Mint, Near Mint, Excellent, Good, Played, Poor, Damaged, raw, graded, or other opened card states | `used` | Even high-grade cards are not submitted as `new` unless the Product is sealed/new. |
| Missing condition for raw, graded, single, or lot products | Excluded | Reason: `missing-condition`. |
| Ambiguous condition wording | Excluded | Reason: `ambiguous-condition`. |

Public listing display and feed payloads must not contradict each other. If a public listing cannot show the same condition claim, the row stays excluded.

## Image Policy

Product Asset Sets are the primary image source. Discovery selects `catalog-detail` variants first because they are Catalog-owned, normalized, public product imagery.

An image is excluded when:

- no candidate image exists;
- the URL is not absolute HTTPS;
- the host is local, staging, or otherwise not production-public for the target feed;
- the candidate dimensions are below launch minimums;
- the image is a loading-only fallback;
- the image is a permanent fallback that has not been approved for Google submission.

Seller Listing Photos are not submitted in the first launch. Marketplace owns those photos as listing evidence, and a separate policy decision is needed before seller-specific imagery can affect Google image rows.

## Offer Mapping

Google offer fields come from Marketplace and Discovery public routing:

- `price` uses the listing price amount and `USD` unless a later currency field is explicitly published.
- `availability` is `in stock` only for active listings with seller availability on and positive quantity.
- `link` is the public listing URL, for example `/listings/<listing_slug>`.
- Inactive, paused, withdrawn, unavailable-seller, suspended-seller, sold-out, hidden, uncrawlable, and indexing-disabled rows are excluded or tombstoned.

Quantity and price changes are feed-affecting facts. Later incremental sync jobs should enqueue rows when Marketplace publishes price, quantity, purchase-limit, lifecycle, seller availability, or seller account state changes.

## Shipping, Returns, And Tax

Launch shipping uses Merchant Center account-level settings as the source of shipping service claims. Row-level feed mapping still records readiness evidence so incomplete rows are excluded before sync:

- ship-from code is present when required;
- shipping allowance policy is available from Marketplace listing facts;
- product measure readiness is true when Catalog/Marketplace publish product measure snapshots;
- operational launch evidence confirms account-level Google shipping settings.

Returns use the Public Presence refunds and returns page as the public policy URL. The first launch label is `chase-sets-standard-returns` unless operations records a different Merchant Center policy label.

Tax remains an account/checkout launch-readiness concern for this slice. The feed mapper does not submit row-level tax fields until Tax and Ordering expose a provider-reviewed row-level policy.

## Operator Evidence

Before production writes are enabled, launch evidence must include:

- counts by eligibility status and exclusion reason;
- counts by image eligibility status and image exclusion reason;
- sampled eligible listing URLs;
- sampled image URLs verified as publicly crawlable;
- the public returns policy URL;
- the Merchant Center shipping and returns setup evidence reference;
- a Tax readiness reference confirming Google-facing claims do not contradict checkout.
