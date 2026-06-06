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
- `Source Observation`
- `Product Asset Set`
- `Reference Type`
- `Reference Record`
- `Display Template`
- `External Catalog Item Reference`
- `External Product Reference`
- `Provider Integration Profile`
- `Catalog Item Image Fallback`
- `Product Measure Profile`
- `Resolved Product Measure`
- `Resolved Display Identity`

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
- `Source Observation` — a provider-sourced candidate record reviewed before it becomes Catalog truth
- `Product Asset Set` — the Catalog-owned normalized set of WebP image variants derived from one source image for a Catalog Item or Source Observation
- `Asset Variant` — one generated WebP file in a Product Asset Set, identified by role, pixel dimensions, device-pixel-ratio target, storage key, byte size, and public URL
- `Source Asset` — the highest-quality imported image retained for provenance and future variant regeneration
- `Reference Type` — a reusable kind of rich descriptive value, such as Expansion, Series, or Product Line
- `Reference Record` — one rich reusable value under a Reference Type, such as Ascended Heroes under Expansion
- `Display Template` — a reusable rule that resolves Catalog Item title and subtitle copy from Fields, Reference Records, Categories, Blueprints, or item-specific overrides
- `Resolved Display Identity` — the Catalog-owned item-level title/subtitle fact produced from Display Templates and fallback metadata for downstream consumption
- `External Catalog Item Reference` — a provider-scoped product identifier mapped to one Catalog Item
- `External Product Reference` — a provider-scoped SKU or sellable identifier mapped to one Catalog Item plus selected Options for Product resolution
- `Provider Integration Profile` — Catalog-owned configuration that defines how one provider's observations, lookup scopes, normalized facts, Catalog mappings, external references, and ambiguity rules are interpreted
- `Catalog Item Image Fallback` — the configured fallback image for a Catalog Item, including whether it is permanent item imagery or loading-only presentation imagery
- `Product Measure Profile` — a reusable Catalog-owned physical measurement rule for Products that share size, weight, stack behavior, and physical flags
- `Resolved Product Measure` — the per-Product measurement snapshot published for downstream shipping quote and fulfillment use

These are Catalog concepts, not compatibility aliases. They support authoring catalog truth while `Catalog Item`, `Dimension`, `Option`, and `Product` define catalog identity.

## Rich Reference Model

Use a `Reference Record` when a field value needs its own durable identity, attributes, or relationships. For example, a Pokemon TCG Expansion is not just text on every card. It can be a Reference Record with card count, release date, abbreviation, source ID, and a relationship to a Series Reference Record.

Reference Record relationships may form a hierarchy. For example, an Expansion can point to a Series, the Series can point to a TCG/Product Line, and the TCG/Product Line can point to a Manufacturer. Catalog Items should select the most specific applicable Reference Record and inherit broader reusable facts through that hierarchy.

Reference Records enrich Catalog Item information. They do not create Product variation and do not affect Product identity unless a Blueprint separately models variation through Dimensions and Options.

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
- A `Source Observation` may be promoted into a Catalog Item after review.
- A `Product Asset Set` belongs to the Source Observation or Catalog Item it describes.
- An `Asset Variant` belongs to exactly one Product Asset Set.
- A `Reference Type` groups Reference Records by natural kind.
- A `Reference Record` may be selected as a Field value on many Catalog Items.
- A `Reference Record` may relate to other Reference Records.
- A `Display Template` may target one Catalog Item, Reference Record, Category, Blueprint, or all Catalog Items.
- A `Resolved Display Identity` belongs to one Catalog Item and one resolved language.
- An `External Catalog Item Reference` belongs to one Catalog Item and does not carry selected Options.
- An `External Product Reference` belongs to one Catalog Item and carries the selected Options needed to resolve the mapped Product.
- A `Catalog Item Image Fallback` belongs to one Catalog Item and may point at a shared Catalog-owned asset used by many items.
- A `Product Measure Profile` may apply to many Products through Blueprint, Category, and selected Option rules.
- A `Resolved Product Measure` belongs to exactly one Product.

## Identity and IDs

Use these identifiers in APIs and schemas:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `reference_type_id`
- `reference_record_id`

Notes:

- `product_id` identifies a catalog-defined Product, not a listing, inventory item, or physical item.
- Avoid formal `item_id` because it is ambiguous.

## Modeling Rules

- A Product must reference exactly one `catalog_item_id`.
- A Product is defined by a valid set of selected Options.
- Options must belong to their respective Dimension.
- A Catalog Item cannot be sold without a Product.
- A reference-shaped Field value must point at one Catalog-owned Reference Record.
- A Reference Record enriches item information but does not change `product_id`.
- A Display Template changes display copy only. It never changes `catalog_item_id`, `product_id`, selected Options, or product-resolution validity.
- Resolved Display Identity is the published Catalog Item display copy fact. Downstream contexts consume it instead of importing or interpreting Display Templates.
- An External Catalog Item Reference must be scoped by provider and must map only to Catalog Item identity.
- An External Product Reference must be scoped by provider and must map to selected Options that are valid for the Catalog Item's active Product schema.
- A Catalog Item Image Fallback never changes `product_id`; it only describes fallback imagery for item presentation.
- Product weight, dimensions, physical flags, and stack behavior are Catalog-owned product facts.
- Shipping price, letter eligibility, and carrier service selection are not Catalog facts; downstream contexts derive them from Resolved Product Measures and their own policies.

## API Guidance

Preferred field names:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `selected_options`
- `product_schema`
- `product_summary`
- `reference_type_id`
- `reference_record_id`
- `display_template_id`
- `display_identity_hash`
- `provider_key`
- `external_key`

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
- Reference Type
- Reference Record

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
- the authoring relationship between Blueprints, Fields, Components, Categories, Reference Records, and Catalog Items
- the template hierarchy used to resolve product-facing Catalog Item title and subtitle copy
- the resolved item-level display identity fact published for downstream title and subtitle updates
- external product references that map provider identifiers to Catalog Item and Product selection truth
- external catalog item references that map provider product identifiers to Catalog Item truth
- the review and promotion policy for provider Source Observations
- the normalized product imagery contract published as Product Asset Sets
- reusable Product Measure Profiles and Resolved Product Measures

Catalog does not define:

- listing aggregation
- multi-select filtering
- faceted search behavior
- shipping quote policy
- package execution

## One-Line Summary

A Catalog Item defines the thing, Dimensions define axes of variation, Options define selectable values, and a Product is a valid sellable combination of selected Options under the Catalog Item; Blueprints, Fields, Components, Categories, Reference Types, Reference Records, Display Templates, Resolved Display Identity, and Product Measure Profiles support authoring, enriching, organizing, naming, and measuring that truth.
