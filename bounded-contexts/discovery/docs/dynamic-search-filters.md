# Dynamic Search Filters

Discovery owns dynamic search filter behavior because filters, facets, result-set narrowing, and browse presentation are Discovery concepts. Catalog remains the upstream source of truth for Catalog Items, Categories, Fields, Dimensions, Options, Blueprints, and Product identity.

## Eligibility

Category remains the primary browse facet.

Field facets are eligible only when the Catalog Field is marked `filterable`. Discovery may denormalize the field name, value type, and item values into its search read model, but Catalog remains the owner of what the Field means.

Dimension facets are eligible when a Dimension appears in a Catalog Item's active Blueprint product schema. Discovery filters by stable `dimension_id` and `option_id` values and uses denormalized labels only for presentation.

## Priority

When many eligible facets exist, Discovery uses deterministic usefulness ranking:

1. Category is always first.
2. Dynamic facet groups are ranked by active-result coverage.
3. Ties favor groups with useful distinct-value counts.
4. Dimension and Field labels break remaining ties for stable rendering.

The default search UI shows the top five dynamic facet groups and the top eight values per group. Broader value discovery should be added through a canonical design-system expand or search interaction before exposing every value.

## Counts

Facet counts are result-aware. Counts should be computed from the active Discovery Query with the candidate facet group's own selection excluded, while all other active filters remain applied. This lets users see useful next refinements without hiding alternatives inside the current group.

## URL Contract

Dynamic filter URLs use stable Catalog identifiers:

- Field filters: `field.<field_id>=<normalized-value>`
- Dimension filters: `dimension.<dimension_id>=<option_id>`

Multiple values for the same Field or Dimension use repeated query parameters. Discovery treats multiple values within one facet group as an OR filter and different facet groups as AND filters.

Labels, display order, and localized copy must not be used as durable filter identifiers.

## Boundary Rules

- Discovery decides filter presentation, ranking, query normalization, and counts.
- Catalog decides Field behavior, Dimension/Option identity, Blueprint applicability, and Product identity.
- Deployables only compose Discovery routes and must not own filter behavior.
