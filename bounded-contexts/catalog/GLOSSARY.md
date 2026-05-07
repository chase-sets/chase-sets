# Catalog Glossary

## Purpose

This glossary defines the formal concepts within the Catalog bounded context.

Use these terms consistently across APIs, internal tools, docs, and formal UI copy:

- `Catalog Item`
- `Dimension`
- `Option`
- `Product`
- `Blueprint`
- `Field`
- `Component`
- `Category`

This glossary focuses on catalog truth and identity. Browsing, filtering, and listing aggregation belong to other bounded contexts such as Discovery and Marketplace.

## Core Model

The catalog is composed of four primary concepts:

- `Catalog Item` — the canonical parent definition of a thing
- `Dimension` — a category of variation used to distinguish Products
- `Option` — a specific selectable value of a Dimension
- `Product` — a valid sellable combination of selected Options under a Catalog Item

## Authoring Model

The current implementation also uses four supporting authoring concepts:

- `Blueprint` — the structural definition that determines applicable Fields, applicable Dimensions, and canonical Dimension order for Product resolution
- `Field` — a descriptive attribute definition for Catalog Items that does not create Product variation
- `Component` — a reusable bundle of Field and Dimension rules used to compose Blueprints
- `Category` — a consumer-facing grouping for browsing and merchandising that does not affect Product identity

These are Catalog concepts, not compatibility aliases. They support authoring catalog truth while `Catalog Item`, `Dimension`, `Option`, and `Product` define catalog identity.

## Product Resolution Model

The current implementation resolves valid Product combinations through blueprint-driven rules. Catalog remains the owner of Product identity and selection validity; downstream contexts consume resolved Product data instead of deciding whether option combinations are valid.

## Relationships

- A `Catalog Item` may have one or more Products.
- A `Product` belongs to exactly one Catalog Item.
- A `Product` is defined by its selected Options.
- A `Dimension` may apply across many Catalog Items.
- An `Option` belongs to exactly one Dimension.
- A `Blueprint` defines the Fields and Dimensions that apply to a Catalog Item.
- A `Field` describes a Catalog Item without changing Product identity.
- A `Component` contributes reusable Field and Dimension rules to Blueprints.
- A `Category` organizes Catalog Items without changing Product identity.

## Identity and IDs

Use these identifiers in APIs and schemas:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`

Notes:

- `product_id` identifies a catalog-defined Product, not a listing, inventory item, or physical item.
- Avoid formal `item_id` because it is ambiguous.

## Modeling Rules

- A Product must reference exactly one `catalog_item_id`.
- A Product is defined by a valid set of selected Options.
- Options must belong to their respective Dimension.
- A Catalog Item cannot be sold without a Product.

## API Guidance

Preferred field names:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `selected_options`
- `product_schema`
- `product_summary`

Avoid:

- `item_id`
- `entry_id`
- `catalog_version_key`
- `version_selection`
- `version_schema`
- `version_summary`

Canonical selection shape:

```json
[
  {
    "dimension_id": "dim_form",
    "option_id": "opt_graded"
  }
]
```

## Copy Guidance

### API and Technical Documentation

Use formal terms:

- Catalog Item
- Dimension
- Option
- Product
- Blueprint
- Field
- Component
- Category

### Internal Tools

Prefer the formal terms unless a simpler label is clearly better for usability.

### UI Copy

- `Item` may be used as shorthand for Catalog Item where it is unambiguous.
- `Options` may be used for selection flows.
- The UI does not need to expose the entire formal model if simpler wording is clearer.

## Boundary

Catalog defines:

- the canonical structure of Catalog Items
- the resolved set of valid Products
- the relationship between Dimensions, Options, and Products
- the authoring relationship between Blueprints, Fields, Components, Categories, and Catalog Items

Catalog does not define:

- listing aggregation
- multi-select filtering
- faceted search behavior

## One-Line Summary

A Catalog Item defines the thing, Dimensions define axes of variation, Options define selectable values, and a Product is a valid sellable combination of selected Options under the Catalog Item; Blueprints, Fields, Components, and Categories support authoring and organizing that truth.
