# Catalog Domain Glossary

This glossary defines the canonical terminology for the Catalog bounded context.

Use these terms consistently in documentation, APIs, events, and internal models.

## Catalog Item

A **Catalog Item** is the canonical sellable item identity used across the marketplace.

Notes:

- Inventory, Marketplace, and Pricing reference Catalog Item IDs.
- A Catalog Item does not contain seller-owned quantity or pricing.

## Product Line

A **Product Line** is the top-level collectible family or game under which catalog items are organized.

Examples:

- Pokemon
- Magic: The Gathering

## Product Set

A **Product Set** is a release grouping within a Product Line.

Examples:

- Base Set
- Modern Horizons 3

## Product Variant

A **Product Variant** is a specific print, edition, finish, language, or other canonical variation of a catalog item.

## Condition Definition

A **Condition Definition** is a shared reference label used to normalize condition language across the marketplace.

Examples:

- Near Mint
- Lightly Played
- Moderately Played

## Listing Metadata

**Listing Metadata** is the subset of canonical catalog data used to normalize search, discovery, and listing creation.
