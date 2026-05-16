# Dynamic Search Filters

Discovery owns dynamic search filter behavior because filters, facets, result-set narrowing, and browse presentation are Discovery concepts. Catalog remains the upstream source of truth for Catalog Items, Categories, Fields, Dimensions, Options, Blueprints, and Product identity.

## Eligibility

Category remains the primary browse facet.

Field facets are eligible only when the Catalog Field is marked `filterable`. Discovery may denormalize the field name, value type, and item values into its search read model, but Catalog remains the owner of what the Field means.

Reference Field facets use stable `reference_record_id` values and human-readable Reference Record names. When a Reference Record has relationships, Discovery may expose additional derived Field facets for related Reference Record types, such as filtering an Expansion field by its related Series. These derived facets are projection-only browse affordances; Catalog remains the source of the Reference Record hierarchy.

Dimension facets are eligible when a Dimension appears in a Catalog Item's active Blueprint product schema. Discovery filters by stable `dimension_id` and `option_id` values and uses denormalized labels only for presentation.

## Priority

When many eligible facets exist, Discovery uses deterministic usefulness ranking:

1. Category is always first.
2. Dynamic facet groups are ranked by active-result coverage.
3. Ties favor groups with useful distinct-value counts.
4. Dimension and Field labels break remaining ties for stable rendering.

The default search UI shows the top five dynamic facet groups and the top eight values per group. Broader value discovery should be added through a canonical design-system expand or search interaction before exposing every value.

## Mobile Presentation

Mobile search uses the canonical marketplace mobile filter pattern from the design system. Focused result pages show one compact filter bar with result summary and active filter count before the result list. Applied filters remain visible and reversible as chips outside the filter sheet.

Opening filters presents a bottom sheet with vertically grouped choices for Category, Language, and ranked dynamic Field and Dimension facets. The sheet keeps 44px touch targets, clear-all access, and a show-results action. Discovery still owns URL-backed Filter State and selection behavior; the design system owns the reusable mobile filter shell and choice-group presentation.

## Counts

Facet counts are result-aware. Counts should be computed from the active Discovery Query with the candidate facet group's own selection excluded, while all other active filters remain applied. This lets users see useful next refinements without hiding alternatives inside the current group.

## Result Set Loading

Buyer-facing search uses cursor-loaded Result Sets instead of page-number pagination. The first batch is loaded by the route from the URL-backed Discovery Query. Additional batches use the returned `nextCursor`, append Search Results in the active Sort Order, and deduplicate by `catalog_item_id`.

The batch size stays finite for latency and marketplace economics, but the browsing experience should not stop at the first 24 Search Results. Product search auto-loads the next cursor batch as the user approaches the end of the list and keeps an accessible load-more or retry action available for assistive technology, network failures, and browsers that cannot run the automatic observer.

Changing search text, Category, Language, Sort Order, or dynamic Filters starts a new Result Set and clears previously appended cursor batches. Cursor loading should not reintroduce offset-based count work; exact totals are requested only when a consumer truly needs total-match metadata.

## URL Contract

Dynamic filter URLs use stable Catalog identifiers:

- Field filters: `field.<field_id>=<normalized-value>`
- Reference Field filters: `field.<field_id>=<reference_record_id>`
- Related Reference Field filters: `field.<field_id>:<reference_type_key>=<reference_record_id>`
- Dimension filters: `dimension.<dimension_id>=<option_id>`

Multiple values for the same Field or Dimension use repeated query parameters. Discovery treats multiple values within one facet group as an OR filter and different facet groups as AND filters.

Labels, display order, and localized copy must not be used as durable filter identifiers.

## Detail Page Handoff

Search Result links preserve selected Dimension filters on item detail URLs so a buyer who narrows search by Product-defining Options lands on the Detail Page with the same Product Options selected. This keeps the path from filter to listing purchase short: matching listings, add-to-cart, buy-now, offer, and Product Alert affordances all receive the selected Product context immediately.

Field filters are intentionally not carried into Product selection because Fields describe Catalog Items and do not define Products.

If Search carries exactly one selected Option for a Dimension, Item Detail validates and applies that selection against the projected Product Schema. If Search carries multiple selected Options for the same Dimension, Item Detail leaves that Dimension unset rather than guessing. Invalid or inapplicable Dimension selections are ignored during Product Schema normalization.

## Bulk Cart Handoff

Discovery owns the buyer-facing bulk action from a Result Set because the scope is a Discovery Query. Checkout owns the Cart mutation. The handoff must use resolved Products, not unresolved Catalog Items.

Bulk add previews the active Discovery Query before committing. The preview resolves eligible Products from selected Dimension filters, shows how many Products are ready, shows skipped items that still need Product Options, and blocks commit when the query is too broad. The first implementation allows up to 250 matching resolved Products in one action so full set-sized adds stay practical without letting very broad tags become long-running cart writes.

Field filters and tags can define Result Set scope, but they do not define Product identity. They may decide which Catalog Items are included in the preview; Dimension filters decide which Product Options can be carried into Cart lines.

## Boundary Rules

- Discovery decides filter presentation, ranking, query normalization, and counts.
- Discovery decides bulk Result Set scope and preview eligibility.
- Catalog decides Field behavior, Dimension/Option identity, Blueprint applicability, and Product identity.
- Checkout decides Cart line validation, duplicate line merging, guest cart handling, and Cart write results.
- Deployables only compose Discovery routes and must not own filter behavior.
