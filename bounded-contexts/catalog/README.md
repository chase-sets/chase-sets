# Catalog Bounded Context

## Purpose

Catalog owns the canonical truth for what a thing is, how it is authored, and which sellable Products can be resolved from it.

Catalog truth uses these core identity concepts:

- `Catalog Item`
- `Dimension`
- `Option`
- `Product`

Catalog authoring uses these supporting concepts:

- `Blueprint`
- `Field`
- `Component`
- `Category`
- `Reference Type`
- `Reference Record`

Together, these terms are the formal Catalog vocabulary. `Catalog Item`, `Dimension`, `Option`, and `Product` define catalog identity and product resolution. `Blueprint`, `Field`, `Component`, `Category`, `Reference Type`, and `Reference Record` define how that catalog truth is authored, described, composed, enriched, and organized.

Graded card product modeling is documented in [Graded Card Data Model](./docs/graded-card-data-model.md).
Provider-fed catalog data is documented in [Source Observation Integration](./docs/source-observation-integration.md).
Provider-owned structural setup is documented in [Provider Integration Profiles](./docs/provider-integration-profiles.md).

## Owns

- Canonical `catalog_item_id` identity
- Dimension definitions and their Options
- Blueprint-driven product resolution rules
- Product schema snapshots used by downstream contexts
- Field values and category membership for Catalog Items
- Provider Source Observations before review and promotion into canonical Catalog Items
- Reference Types and Reference Records that provide rich reusable facts for item fields

## Does Not Own

- Listing aggregation
- Inventory quantities or reservations
- Marketplace offers or bidding workflows
- Order creation and checkout
- Search and discovery filtering behavior

## Catalog Concepts

### Dimension

Owns one axis of variation and its allowed `Option` set.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateDimension`, `ReviseDimension`, `AddOption`, `ReviseOption`, `ReorderOptions`, `DeprecateOption`, `ReactivateOption`, `ActivateDimension`, `DeprecateDimension`, `ArchiveDimension`
- Events: `catalog.dimension.created`, `catalog.dimension.revised`, `catalog.dimension.option-added`, `catalog.dimension.option-revised`, `catalog.dimension.options-reordered`, `catalog.dimension.option-deprecated`, `catalog.dimension.option-reactivated`, `catalog.dimension.activated`, `catalog.dimension.deprecated`, `catalog.dimension.archived`

### Field

Owns one descriptive attribute definition. Fields describe Catalog Items and never create Products.

Field values may be simple values or reference-shaped values. A reference-shaped value points at a Catalog Reference Record when the selected value needs its own metadata, relationships, and lifecycle. For example, a Pokemon card's Expansion field can point at the `Ascended Heroes` Reference Record, and that record can carry card count, release date, abbreviation, source ID, and its relationship to the `Mega Evolution` Series.

### Component

Owns a reusable bundle of field and dimension rules used to compose Blueprints.

### Blueprint

Owns the structural definition used to author Catalog Items and resolve Products.

- Defines which Dimensions apply
- Defines which Fields apply
- Carries canonical dimension ordering for deterministic `product_id` derivation

### Category

Owns consumer-facing grouping metadata. Categories never participate in product identity.

### Reference Type

Owns the reusable kind of rich descriptive data, such as `Expansion`, `Series`, or `Product Line`.

Reference Types do not create Products and do not replace Dimensions. They define the natural-language bucket for Reference Records that Catalog Items may point at through Field values.

### Reference Record

Owns one reusable rich value under a Reference Type, such as `Ascended Heroes` under `Expansion` or `Mega Evolution` under `Series`.

Reference Records can carry attributes and relationships to other Reference Records. These relationships may form a bounded hierarchy such as `Expansion -> Series -> TCG/Product Line -> Manufacturer`. A Catalog Item that points at a Reference Record receives that rich information in item detail read models without duplicating those facts onto every item.

### Catalog Item

Owns the canonical parent item.

- Commands use explicit Catalog Item naming such as `CreateCatalogItem`, `AssignBlueprintToCatalogItem`, and `PublishCatalogItem`
- A Product cannot exist without exactly one Catalog Item

### Source Observation

Owns a provider-sourced candidate record before it becomes Catalog truth.

- TCGdex is the first provider.
- Source Observations carry provider identity, source URL, source hash, normalized candidate fields, image URLs, and review status.
- Promotion emits Catalog Item commands; rejection records why the source record should not be used.
- Source Observations are not downstream product truth until promoted into Catalog Items.

## Product Resolution

`Product` is a derived catalog concept in this implementation. There is no persisted Product aggregate or Product event stream in this pass.

`product_id` is derived from:

1. `catalog_item_id`
2. Canonical blueprint dimension order
3. The normalized set of selected `option_id` values

Rules:

1. `selected_options` must contain valid Options for the active Product schema.
2. Product identity excludes labels, display order, categories, and descriptive field values.
3. Reordering labels or revising copy must not change `product_id`.
4. Changing canonical dimension order on an active Blueprint is identity-affecting and therefore forbidden.

## Boundary Contracts

Use these names at API and storage boundaries:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `selected_options`
- `product_schema`
- `product_summary`

Canonical selection shape:

```ts
type SelectedOptionEntry = {
  dimensionId: string;
  optionId: string;
};

type ProductDescriptor = {
  productId: ProductId;
  selectedOptions: readonly SelectedOptionEntry[];
};
```

## Integration Guidance

Structural authoring streams remain Catalog-internal. Downstream contexts should consume Catalog Item snapshots and resolved product data, not internal authoring aggregates.

Initial integration surface:

- `CatalogItemPublished`
- `CatalogItemUpdated`
- `CatalogItemArchived`

Those events should carry the Catalog Item snapshot plus the `product_schema` downstream consumers need to validate `selected_options` and compute `product_id`.

## Invariants

1. Dimensions create variation; Fields describe Catalog Items.
2. A Product always belongs to exactly one Catalog Item.
3. Options belong to exactly one Dimension.
4. Published identity-bearing structure is append-only.
5. Downstream contexts must reference `catalog_item_id` plus `product_id`, never labels.
6. Reference Records enrich descriptive item information but do not change `product_id`.
7. Reusable descriptive hierarchy belongs on Reference Records, not repeated Catalog Item fields. Catalog Items should keep only item-specific facts such as printed name, card number, HP, attacks, and direct reference selections.
