# Catalog Bounded Context

## Purpose

Catalog owns the canonical truth for what a thing is, how it is authored, and which sellable Products can be resolved from it.

Catalog truth uses these core identity concepts:

- `Catalog Item`
- `Dimension`
- `Option`
- `Product`
- `Product Key`

Catalog authoring uses these supporting concepts:

- `Blueprint`
- `Field`
- `Component`
- `Category`
- `Reference Type`
- `Reference Record`
- `Display Template`

Together, these terms are the formal Catalog vocabulary. `Catalog Item`, `Dimension`, `Option`, and `Product` define catalog identity and product resolution. `Blueprint`, `Field`, `Component`, `Category`, `Reference Type`, `Reference Record`, and `Display Template` define how that catalog truth is authored, described, composed, enriched, named, and organized.

Graded card product modeling is documented in [Graded Card Data Model](./docs/graded-card-data-model.md).
Provider-fed catalog data is documented in [Source Observation Integration](./docs/source-observation-integration.md).
Catalog-owned provider scope planning is documented in [Catalog Sync Scope Planning](./docs/catalog-sync-scope-planning.md).
Canonical scope records are documented in [Catalog Scope Registry](./docs/scope-registry.md).
Scope-first merge-candidate handoff guidance is documented in [Catalog Scope Sync And Merge Candidate Handoff](./docs/catalog-scope-sync-merge-candidate-handoff.md).
Provider-owned structural setup is documented in [Provider Integration Profiles](./docs/provider-integration-profiles.md).
External product mapping for seller inventory imports is documented in [External Product References](./docs/external-product-references.md).
Resolved display copy from Display Templates is documented in [Catalog Resolved Display Identity](./docs/resolved-display-identity.md).
Alias and translation equivalence facts are documented in [Catalog Alias Vocabulary And Ownership ADR](./docs/catalog-alias-vocabulary-adr.md).
Published resolved alias facts for downstream search and display are documented in [Catalog Resolved Aliases](./docs/resolved-aliases.md).
Product-to-product containment is documented in [Product Contents Contract](./docs/product-contents-contract.md).
Admin bulk workflow selection, preview/confirm, and job semantics are documented in [Catalog Admin Bulk Workflows](./docs/admin-bulk-workflows.md).
Bulk publish policy for draft Catalog Items is documented in [Bulk Catalog Item Publish](./docs/bulk-catalog-item-publish.md).
Alias source governance and acceptance-disposition policy are documented in [Catalog Alias Source Governance](./docs/catalog-alias-source-governance.md).
Catalog Item image and fallback-image facts are documented in [Catalog Item Imagery](./docs/catalog-item-imagery.md).
Physical shipping measurement facts are documented in [Product Measures](./docs/product-measures.md).
The v2 integration control-plane IA — three pages, two utilities, and the per-entity action vocabulary — is documented in [Catalog Control Plane Blueprint (v2)](./docs/catalog-control-plane-blueprint-v2.md).

## Owns

- Canonical `catalog_item_id` identity
- Dimension definitions and their Options
- Blueprint-driven product resolution rules
- Product schema snapshots used by downstream contexts
- Field values and category membership for Catalog Items
- Provider Source Observations before review and promotion into canonical Catalog Items
- Catalog Sync Scopes and provider participation previews that decide which provider units may pull Source Observations
- Catalog Scope Records that make product-line, series, expansion, and set sync identity canonical before provider mappings are applied
- Provider Scope Mappings that review and persist provider execution coordinates for canonical Catalog Scope Records
- External Catalog Item References that map third-party product identifiers to Catalog Item truth
- External Product References that map third-party SKU identifiers to Product selection truth
- Reference Types and Reference Records that provide rich reusable facts for item fields
- Display Templates that resolve reusable product-facing title and subtitle copy from Catalog facts
- Resolved Display Identity as the Catalog-owned item-level display copy fact published to downstream contexts
- Catalog Aliases and Alias Candidates: the reviewable, typed, confidence-scored alias facts and the auto-accept, revocation, and decay policy published to downstream contexts
- Resolved Aliases: the Catalog-owned per-target, per-language published alias fact derived from accepted aliases, published to downstream search and display
- Product Contents: the Catalog-owned relationship describing what one configured Product contains, published to downstream contexts as a stable resolved fact

## Does Not Own

- Listing aggregation
- Inventory quantities or reservations
- Marketplace offers or bidding workflows
- Order creation and checkout
- Search and discovery filtering behavior

## Ubiquitous Language

Catalog terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Catalog Item
- Dimension
- Blueprint
- Component
- Category
- Reference Type
- Reference Record
- Display Template
- Source Observation
- Catalog Sync Scope
- Catalog Scope Record
- Provider Scope Mapping
- External Catalog Item Reference
- External Product Reference
- Product Contents

See [Catalog Concepts](#catalog-concepts) below for what each aggregate owns.

## Incoming Dependencies

- None. Catalog is a root context: it has no `allowedContextDependencies` on other bounded-context packages and no event subscriptions from other contexts today.

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

Owns the reusable kind of rich descriptive data, such as `Expansion`, `Set`, `Series`, or `Product Line`.

Reference Types do not create Products and do not replace Dimensions. They define the natural-language bucket for Reference Records that Catalog Items may point at through Field values.

### Reference Record

Owns one reusable rich value under a Reference Type, such as `Ascended Heroes` under `Expansion`, `Time Spiral` under `Set`, or `Mega Evolution` under `Series`.

Reference Records can carry attributes and relationships to other Reference Records. These relationships may form a bounded hierarchy such as `Expansion -> Series -> TCG/Product Line -> Manufacturer`. A Catalog Item that points at a Reference Record receives that rich information in item detail read models without duplicating those facts onto every item.

### Display Template

Owns reusable title and subtitle resolution rules for Catalog Items.

Display Templates produce display copy from Catalog Item Fields, selected Reference Records and their attributes or relationships, assigned Categories, assigned Blueprint, or a Catalog Item-specific override. They follow this override hierarchy:

1. Catalog Item
2. Reference Record
3. Category
4. Blueprint
5. Global
6. Catalog Item metadata fallback

Display Templates never affect `catalog_item_id`, `product_id`, selected Options, or product-resolution validity.

Resolved Display Identity is the item-level title/subtitle fact produced from Display Templates and fallback metadata. Catalog persists and publishes this fact so downstream contexts update display copy without subscribing to internal Display Template events.

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

### Catalog Sync Scope

Owns provider-neutral sync intent before Source Observation provider jobs run.

- Represents semantic Catalog scope such as Pokemon TCG, English, Expansion, or Set-style source scopes
- Plans required and optional provider-unit participation before enqueueing provider pulls
- Resolves each eligible provider unit into a child `SourceObservationIntegrationJobScope`
- Keeps split, update, and delete decisions in Catalog review; `delete` means candidate rejection or ignore, not canonical Catalog Item/Product removal
- Providers never write canonical Catalog Item or Product truth directly

### Catalog Scope Record

Owns one canonical sync identity record derived from a Catalog Reference Record, such as a product line, series, Pokemon Expansion, or set-style scope for Magic, Yu-Gi-Oh!, One Piece, and Lorcana.

Catalog Scope Records are provider-independent. They carry product domain, scope kind, Reference Record id/key, lifecycle status, hierarchy links, release date, official set code, and language editions before any Provider Scope Mapping chooses provider ids or names for sync execution.

### Provider Scope Mapping

Owns the reviewed bridge from one provider unit to one Catalog Scope Record.

Provider Scope Mappings are keyed by `scope_record_id`, `provider_key`, and `unit_key`. They persist provider execution coordinates such as product line id, series id, set id, set name, and language coordinates with confidence, provenance, and review status. Only `accepted` and `auto-accepted` mappings are queryable as execution-ready scope mappings; `rejected` and `revoked` mappings remain as audit evidence.

### External Catalog Item Reference

Owns the mapping between a provider-scoped product identifier and one Catalog Item.

- TCGplayer Product IDs are Catalog Item references.
- A Catalog Item reference does not choose selected Options and therefore does not fully resolve a Chase Sets Product when the active Product schema requires options.

### External Product Reference

Owns the mapping between a provider-scoped product identifier and one Catalog Item plus selected Options.

- References are scoped by provider key and external key.
- External keys may include an identifier namespace such as `listing:`, `variant:`, `sku:`, `barcode:`, or `product:` when a provider exposes more than one identifier class.
- TCGplayer SKU IDs are Product references because they can map to selected Options.
- Inventory and Marketplace consume these references through projections; they do not author provider identity.

### Product Contents

Owns the relationship between one container Product selection and the Catalog Items or Product selections it contains.

Product Contents command inputs use `catalog_item_id` plus `selected_options`; read and projection layers derive `product_id` when a resolved Product ID is needed. Product-line-specific meanings such as pack, deck, accessory, insert, guaranteed inclusion, or random inclusion are configured through Product Content Types and Inclusion Policies, not hardcoded in Catalog core.

## Product Resolution

`Product` is a derived catalog concept in this implementation. There is no persisted Product aggregate or Product event stream in this pass.

Product identity is the tuple `(catalog_item_id, selected_options)`. `product_id` is the existing API, storage, and event field for a deterministic `ProductKey` derived from:

1. `catalog_item_id`
2. Canonical blueprint dimension order
3. The normalized set of selected `option_id` values

`ProductKey` is a display and selection lookup key, not an independently minted `ProductId`. The `product_id` field name remains on existing wire and event payloads because those events are append-only history.

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
  productId: ProductKey;
  selectedOptions: readonly SelectedOptionEntry[];
};
```

## Outgoing Integration Events

Downstream contexts (Checkout, Discovery, Inventory, Marketplace, Ordering, Pricing) subscribe directly to Catalog's per-aggregate lifecycle streams, not only to the resolved-fact surface:

- Catalog Item: `catalog.catalog-item.created`, `.blueprint-assigned`, `.metadata-revised`, `.published`, `.retired`, `.archived`, `.field-value-set`, `.field-value-cleared`, `.category-assigned`, `.category-removed`, `.tags-set`, `.image-urls-set`, `.image-fallback-set`, `.image-fallback-cleared`, `.product-asset-sets-set`, `.external-catalog-item-reference-linked`, `.external-catalog-item-reference-unlinked`, `.external-product-reference-linked`, `.external-product-reference-unlinked`
- Resolved facts: `catalog.catalog-item.display-identity-resolved`, `catalog.catalog-item.aliases-resolved`, `catalog.catalog-item.product-measures-resolved`, `catalog.product-contents.resolved`
- Blueprint: `catalog.blueprint.created`, `.revised`, `.dimensions-set`, `.product-resolution-rules-set`, `.published`
- Dimension: `catalog.dimension.created`, `.revised`, `.option-added`, `.option-revised`, `.options-reordered`
- Category: `catalog.category.created`, `.revised`, `.published`, `.deprecated`, `.archived`
- Field: `catalog.field.created`, `.configured`
- Reference Record: `catalog.reference-record.created`, `.revised`, `.published`, `.deprecated`, `.archived`

`catalog.reference-record.aliases-resolved` is published but has no subscriber today.

`support/runtime-support/catalog-events.ts` defines separate PascalCase `CatalogItemPublished`, `CatalogItemUpdated`, and `CatalogItemArchived` integration event types. Nothing in this repository publishes or subscribes to them; treat them as unused scaffolding, not the live integration surface, until they gain a publisher and a consumer.

Catalog Item events carry the Catalog Item snapshot plus the `product_schema` downstream consumers need to validate `selected_options` and compute `product_id`.

Display Template authoring events are Catalog-internal. Downstream contexts consume the item-level display identity fact when title/subtitle copy changes because of template policy.

Alias review and source-governance events are Catalog-internal. Downstream search and display consume only the resolved alias fact `catalog.catalog-item.aliases-resolved` (and, once a consumer subscribes, `catalog.reference-record.aliases-resolved`), never `Alias Candidate` records, provider profiles, or the alias review state machine. The resolved alias fact follows the same derived-fact pattern as Resolved Display Identity: Catalog publishes a stable per-target, per-language alias list with hash/version metadata only when the resolved hash changes, and a revoked or rejected alias publishes a resolved fact that drops it (an empty/retracted list) so consumers remove it. See [Catalog Resolved Aliases](./docs/resolved-aliases.md).

Product Contents authoring, review, provider evidence, and configuration events are Catalog-internal. Downstream contexts consume only `catalog.product-contents.resolved`, never unresolved provider evidence or Product Content Type internals outside the resolved published shape. See [Product Contents Contract](./docs/product-contents-contract.md).

## Invariants

1. Dimensions create variation; Fields describe Catalog Items.
2. A Product always belongs to exactly one Catalog Item.
3. Options belong to exactly one Dimension.
4. Published identity-bearing structure is append-only.
5. Downstream contexts must carry the Product identity tuple `(catalog_item_id, selected_options)`; `product_id` may carry its derived `ProductKey` for display and selection lookup, never as standalone identity.
6. Reference Records enrich descriptive item information but do not change `product_id`.
7. Reusable descriptive hierarchy belongs on Reference Records, not repeated Catalog Item fields. Catalog Items should keep only item-specific facts such as printed name, card number, HP, attacks, and direct reference selections.
8. Product-facing title and subtitle copy should come from Display Templates whenever the copy can be expressed from Fields and Reference Records; repeated manual metadata is fallback and exception data.
9. External catalog item references map provider product identifiers to Catalog Item truth; external product references map provider SKU identifiers to Product selection truth; title parsing remains review evidence until promoted into an explicit reference.
10. Product Contents model containment between Catalog selections; fields, tags, categories, Reference Record relationships, and external references must not become substitute containment models.

## Tests

Run `pnpm --filter @chase-sets/catalog run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/catalog run test` before opening a PR.
