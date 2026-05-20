# Dynamic Search Filters

Discovery owns dynamic search filter behavior because filters, facets, result-set narrowing, and browse presentation are Discovery concepts. Catalog remains the upstream source of truth for Catalog Items, Categories, Fields, Dimensions, Options, Blueprints, and Product identity.

## Eligibility

Category remains the primary browse facet.

Field facets are eligible only when the Catalog Field is marked `filterable`. Discovery may denormalize the field name, value type, and item values into its search read model, but Catalog remains the owner of what the Field means.

Reference facets use stable `reference_record_id` values and human-readable Reference Record names. Direct and inherited Reference Records are presented by Catalog Reference Type, such as Product Line, Series, and Expansion for Pokemon Trading Cards. When a Catalog Item selects an Expansion Reference Record, Discovery may expose that Expansion plus inherited Series and Product Line Reference facets. These facets are projection-only browse affordances; Catalog remains the source of the Reference Record hierarchy.

Reference-shaped Field filters remain accepted as compatibility aliases for existing links and tests, but buyer-facing search presents first-class Reference Type facets instead of field-derived labels such as `Expansion Series`.

Dimension facets are eligible when a Dimension appears in a Catalog Item's active Blueprint product schema. Discovery filters by stable `dimension_id` and `option_id` values and uses denormalized labels only for presentation.

## Priority

When many eligible facets exist, Discovery uses deterministic usefulness ranking:

1. Category is always first.
2. Applied facet groups stay visible while they are active.
3. Dynamic facet groups are ranked by buyer decision value and active-result coverage.
4. Ties favor groups with useful distinct-value counts rather than the fewest options alone.
5. Dimension and Field labels break remaining ties for stable rendering.

The default search UI shows the ranked dynamic facet groups and their most useful values as top-level filters. Few options can make a facet easier to scan, but low option count is not enough to move a weak facet ahead of a buyer-critical facet such as Card Name, Card Number, Set, Condition, or other category-specific decision facts.

Long option lists use progressive depth instead of nested scrolling. Discovery should show a concise default set, keep selected values visible, expose `Show more` / `Show less` when more values are useful, and provide option search for high-cardinality facets such as card name, card number, set, player, team, seller, franchise, character, or other catalog-specific attributes.

Selected Filters remain visible in active chips and in their owning facet group even when refreshed facet values would otherwise exclude them from the top-ranked options. A selected Filter is part of Filter State; it must not disappear from the UI until the buyer removes it or clears filters.

## Mobile Presentation

Mobile search uses the canonical marketplace mobile filter pattern from the design system. Focused result pages show one compact filter bar with result summary and active filter count before the result list. Applied filters remain visible and reversible as chips outside the filter sheet.

Opening filters presents a bottom sheet with top-level vertically grouped choices for Category, Language, and ranked dynamic Reference, Field, and Dimension facets. The sheet keeps 44px touch targets, clear-all access, and a show-results action. Discovery still owns URL-backed Filter State and selection behavior; the design system owns the reusable mobile filter shell and choice-group presentation.

The mobile filter sheet owns the vertical scroll. Individual facet groups must not introduce their own scrollbars. Dense facets should use search, show more/show less, or replace the sheet body with a focused facet-picking section. If the focused section becomes long, stateful, or route-worthy, promote it to a Full Page instead of nesting scroll regions inside the sheet.

## Counts

Facet counts are result-aware. Counts should be computed from the active Discovery Query with the candidate facet group's own selection excluded, while all other active filters remain applied. This lets users see useful next refinements without hiding alternatives inside the current group.

Changing Filter State refreshes the Result Set, facet availability, counts, and option ordering. Unavailable zero-count options are hidden by default, except selected options remain visible so buyers can understand and reverse the current constraint. Discovery can add an explicit expert-only unavailable-options view later if a workflow needs full taxonomy comparison.

## Result Set Loading

Buyer-facing search uses cursor-loaded Result Sets instead of page-number pagination. The first batch is loaded by the route from the URL-backed Discovery Query. Additional batches use the returned `nextCursor`, append Search Results in the active Sort Order, and deduplicate by `catalog_item_id`.

The batch size stays finite for latency and marketplace economics, but the browsing experience should not stop at the first 24 Search Results. Product search auto-loads the next cursor batch as the user approaches the end of the list and keeps an accessible load-more or retry action available for assistive technology, network failures, and browsers that cannot run the automatic observer.

Desktop search keeps the filter rail sticky so filters remain reachable while cursor batches append to the Result Set. The filter rail may be the single scrollable filter surface when content exceeds the viewport, but individual facet groups must not have independent scrollbars. This keeps scroll ownership obvious and prevents a small facet list from trapping the pointer wheel or trackpad gesture while the surrounding page also scrolls.

Changing search text, Category, Language, Sort Order, or dynamic Filters starts a new Result Set and clears previously appended cursor batches. Cursor loading should not reintroduce offset-based count work; exact totals are requested only when a consumer truly needs total-match metadata.

## URL Contract

Dynamic filter URLs use stable Catalog identifiers:

- Field filters: `field.<field_id>=<normalized-value>`
- Reference filters: `reference.<reference_type_key>=<reference_record_id>`
- Legacy Reference Field filters: `field.<field_id>=<reference_record_id>`
- Legacy Related Reference Field filters: `field.<field_id>:<reference_type_key>=<reference_record_id>`
- Dimension filters: `dimension.<dimension_id>=<option_id>`

Multiple values for the same Field, Reference Type, or Dimension use repeated query parameters. Discovery treats multiple values within one facet group as an OR filter and different facet groups as AND filters.

Labels, display order, and localized copy must not be used as durable filter identifiers.

## Detail Page Handoff

Search Result links preserve selected Dimension filters on item detail URLs so a buyer who narrows search by Product-defining Options lands on the Detail Page with the same Product Options selected. This keeps the path from filter to listing purchase short: matching listings, add-to-cart, buy-now, offer, and Product Alert affordances all receive the selected Product context immediately.

Field and Reference filters are intentionally not carried into Product selection because Fields and Reference Records describe Catalog Items and do not define Products.

If Search carries exactly one selected Option for a Dimension, Item Detail validates and applies that selection against the projected Product Schema. If Search carries multiple selected Options for the same Dimension, Item Detail leaves that Dimension unset rather than guessing. Invalid or inapplicable Dimension selections are ignored during Product Schema normalization.

## Bulk Cart Handoff

Discovery owns the buyer-facing bulk action from a Result Set because the scope is a Discovery Query. Checkout owns the Cart mutation. The handoff must use resolved Products, not unresolved Catalog Items.

Bulk add previews the active Discovery Query before committing. The preview resolves eligible Products from selected Dimension filters, shows how many Products are ready, shows skipped items that still need Product Options, and blocks commit when the query is too broad. The first implementation allows up to 250 matching resolved Products in one action so full set-sized adds stay practical without letting very broad tags become long-running cart writes.

Field filters, Reference filters, and tags can define Result Set scope, but they do not define Product identity. They may decide which Catalog Items are included in the preview; Dimension filters decide which Product Options can be carried into Cart lines.

## Boundary Rules

- Discovery decides filter presentation, ranking, query normalization, and counts.
- Discovery decides bulk Result Set scope and preview eligibility.
- Catalog decides Field behavior, Dimension/Option identity, Blueprint applicability, and Product identity.
- Checkout decides Cart line validation, duplicate line merging, guest cart handling, and Cart write results.
- Deployables only compose Discovery routes and must not own filter behavior.
