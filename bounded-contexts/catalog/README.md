# Catalog Bounded Context

## Purpose

Catalog owns the canonical product model for what can be bought or sold.

It defines the structure used to describe items, the axes that create valid sellable variations, and the deterministic rules used by downstream contexts to resolve item versions.

## Feature vs Composition

- **Feature code stays in Catalog slices.** Domain logic, query handlers, projections, and read-model shaping remain inside Catalog-owned feature slices.
- **`routes/` is adapter-only.** Files in `bounded-contexts/catalog/routes/` should be deployable adapter modules that expose route entrypoints and delegate to slice-local feature modules.
- **`shell-support/` is composition-only.** Put layout, shell wiring, and host-level composition helpers under `bounded-contexts/catalog/shell-support/`; avoid feature domain/query/projection code there.
- **Deployables remain thin roots.** Deployables should consume generated mount inventories (`deployables/*/app/context-routes.generated.ts` and `deployables/*/app/context-shell.generated.ts`) and point to Catalog-owned route modules.

## Owns

- Dimension definitions and allowed choices
- Field definitions and validation or behavior flags
- Reusable configuration components
- Blueprint structure and version-formation rules
- Consumer-facing category definitions
- Canonical catalog item identity
- Item field values and category membership
- Version-resolution rules derived from item plus selection

## Does Not Own

- Seller inventory quantities or reservations
- Public listing lifecycle
- Buyer offers or bids
- Order creation
- Shipment execution
- Pricing strategy or repricing workflows

## Ubiquitous Language

Catalog terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Dimension
- Field
- Component
- Blueprint
- Category
- Catalog Item
- Version Resolution Policy

## Aggregate Model

### Dimension

Owns one version-forming axis and its allowed `Choice` set.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateDimension`, `ReviseDimension`, `AddChoice`, `ReviseChoice`, `ReorderChoices`, `DeprecateChoice`, `ReactivateChoice`, `ActivateDimension`, `DeprecateDimension`, `ArchiveDimension`
- Domain events: `catalog.dimension.created`, `catalog.dimension.revised`, `catalog.dimension.choice-added`, `catalog.dimension.choice-revised`, `catalog.dimension.choices-reordered`, `catalog.dimension.choice-deprecated`, `catalog.dimension.choice-reactivated`, `catalog.dimension.activated`, `catalog.dimension.deprecated`, `catalog.dimension.archived`
- Notes: `Choice` is a child entity, not an aggregate. Choice IDs are stable. Labels and display order may change without changing version identity.

### Field

Owns one descriptive attribute definition and its validation or behavior flags.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateField`, `ConfigureField`, `ActivateField`, `DeprecateField`, `ArchiveField`
- Domain events: `catalog.field.created`, `catalog.field.configured`, `catalog.field.activated`, `catalog.field.deprecated`, `catalog.field.archived`
- Notes: Fields describe items only. They never create versions.

### Component

Owns a reusable bundle of field and dimension rules used to compose blueprints.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateComponent`, `AddFieldRuleToComponent`, `RemoveFieldRuleFromComponent`, `AddDimensionRuleToComponent`, `RemoveDimensionRuleFromComponent`, `ConfigureComponentRules`, `ActivateComponent`, `DeprecateComponent`, `ArchiveComponent`
- Domain events: `catalog.component.created`, `catalog.component.field-rule-added`, `catalog.component.field-rule-removed`, `catalog.component.dimension-rule-added`, `catalog.component.dimension-rule-removed`, `catalog.component.rules-configured`, `catalog.component.activated`, `catalog.component.deprecated`, `catalog.component.archived`
- Notes: Components are compositional helpers only. They do not imply inheritance.

### Blueprint

Owns the structural definition of a product type: applicable fields, applicable dimensions, allowed choice constraints, and canonical dimension order.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateBlueprint`, `AttachComponentToBlueprint`, `DetachComponentFromBlueprint`, `SetBlueprintFields`, `SetBlueprintDimensions`, `SetBlueprintVersionRules`, `PublishBlueprint`, `DeprecateBlueprint`, `ArchiveBlueprint`
- Domain events: `catalog.blueprint.created`, `catalog.blueprint.component-attached`, `catalog.blueprint.component-detached`, `catalog.blueprint.fields-set`, `catalog.blueprint.dimensions-set`, `catalog.blueprint.version-rules-set`, `catalog.blueprint.published`, `catalog.blueprint.deprecated`, `catalog.blueprint.archived`
- Notes: Blueprint owns deterministic version-formation rules. Once active, identity-affecting structure is immutable. Breaking changes require a successor blueprint.

### Category

Owns consumer-facing browse and merchandising grouping metadata.

- State machine: `Draft -> Active -> Deprecated -> Archived`
- Commands: `CreateCategory`, `ReviseCategory`, `PublishCategory`, `DeprecateCategory`, `ArchiveCategory`
- Domain events: `catalog.category.created`, `catalog.category.revised`, `catalog.category.published`, `catalog.category.deprecated`, `catalog.category.archived`
- Notes: Categories can change browse organization, but never version logic.

### Catalog Item

Owns the canonical sellable product identity, blueprint assignment, field values, and category membership.

- State machine: `Draft -> Active -> Retired -> Archived`
- Commands: `CreateItem`, `AssignBlueprintToItem`, `SetItemFieldValue`, `ClearItemFieldValue`, `AssignItemToCategory`, `RemoveItemFromCategory`, `PublishItem`, `ReviseItemMetadata`, `RetireItem`, `ArchiveItem`
- Domain events: `catalog.catalog-item.created`, `catalog.catalog-item.blueprint-assigned`, `catalog.catalog-item.field-value-set`, `catalog.catalog-item.field-value-cleared`, `catalog.catalog-item.category-assigned`, `catalog.catalog-item.category-removed`, `catalog.catalog-item.published`, `catalog.catalog-item.metadata-revised`, `catalog.catalog-item.retired`, `catalog.catalog-item.archived`
- Notes: `FieldValue` is a value object inside the item. After publish, `blueprintId` is immutable. Field values and categories may still change because they do not affect version identity.

### Version Resolution Rules

`Version` is a derived concept, not an aggregate. Version resolution must follow these rules:

1. `Version` is resolved from `CatalogItemId + canonical Blueprint dimension order + selected Choice IDs`.
2. `Selection` must contain exactly one valid `Choice` for each required `Dimension` in the item's active blueprint.
3. `Version` identity excludes labels, display order, categories, and field values.
4. Changing a `Choice` label or display order must not change the computed version key.
5. Changing canonical dimension order on an active blueprint is forbidden because it would change version identity.
6. An item may change `blueprintId` only while in `Draft`. After `catalog.catalog-item.published`, structural change requires a new item.
7. Invalid or incomplete selections return validation errors and emit no domain events.

## Derived Concepts

These concepts are intentionally not aggregate roots and must not get their own event streams.

### Choice

- Model as: child entity inside `Dimension`
- Mutation model: mutated only through `Dimension` commands
- Notes: has a stable ID, display label, display order, and optional numeric metadata

### Field Value

- Model as: value object inside `Catalog Item`
- Mutation model: mutated only through `Catalog Item` commands
- Notes: item-specific instance of a `Field`

### Selection

- Model as: transient value object
- Mutation model: no persisted commands or events
- Notes: may be partial or complete and is used for validation and UI state only

### Version

- Model as: derived read model and deterministic key
- Mutation model: no persisted commands or events
- Notes: a valid complete selection for one item and never a primary aggregate

## Outgoing Integration Events

Keep the shared integration surface small and item-centric. Structural authoring events stay internal to Catalog.

Expose only these integration events initially:

- `CatalogItemPublished`
- `CatalogItemUpdated`
- `CatalogItemRetired`
- `CatalogItemArchived`

The integration surface follows these rules:

- Do not publish raw `Dimension`, `Field`, `Component`, `Blueprint`, or `Category` streams outside Catalog.
- `CatalogItemPublished` and `CatalogItemUpdated` should carry the item snapshot downstream consumers need: `catalogItemId`, item status, descriptive field values, category IDs, and a resolved version schema snapshot sufficient to validate selections and compute the version key.
- Marketplace, Inventory, and Pricing should consume item facts, not internal authoring aggregates.

### Public APIs, Interfaces, and Types

This pass is documentation-first, but the intended contract surface should remain stable:

1. Keep `CatalogItemId` as the catalog root ID defined in [`ids.ts`](./ids.ts).
2. Keep the derived version identity local to Catalog as `CatalogVersionKey = Branded<string, "CatalogVersionKey">` using [`contracts/primitives/brand.ts`](../../contracts/primitives/brand.ts).
3. Keep `BlueprintId`, `DimensionId`, `ChoiceId`, `FieldId`, `ComponentId`, and `CategoryId` catalog-internal unless another context proves it needs to address them directly.
4. Define these downstream-facing value shapes for later implementation:

```ts
type CatalogSelectionEntry = {
  dimensionId: string;
  choiceId: string;
};

type CatalogVersionDescriptor = {
  versionKey: CatalogVersionKey;
  selection: readonly CatalogSelectionEntry[];
};
```

5. There is no `VersionCreated` event and no `CatalogVersionId` ULID because `Version` is derived, not stored.

## Invariants

1. Dimensions create variation; fields describe items and never change version identity.
2. Each item references exactly one active blueprint at publish time.
3. Published items must satisfy all required field rules from their blueprint before they can become active.
4. Categories never participate in version computation.
5. Published identity-bearing structure is append-only: no destructive edits to active dimensions, choices, or blueprint ordering.
6. A computed version key must be stable for the same item and logically equivalent selection.
7. Downstream contexts must reference item identity plus derived version identity, never display labels.

### Acceptance Test Scenarios

1. Create a `Dimension`, add choices, activate it, and verify only the `Dimension` aggregate emits events for choice changes.
2. Create a `Blueprint` with ordered dimensions and required fields, publish it, and verify later attempts to change dimension order are rejected.
3. Create an `Item`, assign a published blueprint, set required field values, publish it, and verify publish fails if required fields are missing.
4. Compute a `Version` from a complete valid `Selection` and verify no events are persisted for the computation itself.
5. Change a choice label or display order and verify the same logical selection still yields the same `CatalogVersionKey`.
6. Attempt to use a partial or invalid `Selection` and verify validation fails with no events.
7. Change item categories on an active item and verify the version key is unchanged.
8. Attempt to reassign `blueprintId` after `catalog.catalog-item.published` and verify the command is rejected.
9. Retire an item and verify `CatalogItemRetired` is emitted while historical version resolution remains possible.
10. Deprecate a structural definition and verify it can remain referenced by existing active items but cannot be attached to new drafts.

## Open Extraction Candidates

- Separate version-resolution services can be extracted later if computed version descriptors need independent scaling or caching.
- Taxonomy management can be extracted later if category operations become materially more complex than merchandising metadata.
- Bulk catalog import workflows can be extracted later if authoring throughput requires a dedicated ingestion boundary.
