# Catalog Glossary

## Purpose

This glossary defines the formal concepts within the Catalog bounded context.

Use these terms consistently across APIs, internal tools, docs, and formal UI copy:

- `Catalog Item`
- `Dimension`
- `Option`
- `Product`
- `Product Key`
- `Blueprint`
- `Field`
- `Component`
- `Category`
- `Source Observation`
- `Catalog Sync Scope`
- `Catalog Scope Record`
- `Provider Scope Observation`
- `Provider Scope Mapping`
- `Scope Coverage`
- `Scope Sync`
- `Scope Sync Batch`
- `Production Catalog Completion Report`
- `Provider Participation Preview`
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
- `Catalog Alias`
- `Alias Candidate`
- `Alias Type`
- `Alias Confidence`
- `Alias Review Status`
- `Provider Option Query Key Synonym`
- `Provider Option Value Synonym`
- `Product Contents`
- `Product Content Line`
- `Product Content Type`
- `Product Content Inclusion Policy`

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
- `Catalog Sync Scope` — a provider-neutral Catalog sync intent, such as Pokemon TCG / English / Expansion, resolved before provider pulls create Source Observations
- `Catalog Scope Record` — a canonical Catalog-owned sync identity row derived from a Reference Record for a product line, series, Pokemon Expansion, or set-style product-domain scope
- `Provider Scope Observation` — hash-deduped evidence that one provider unit currently exposes a product-line, series, expansion, set, or language option in provider vocabulary
- `Provider Scope Mapping` — a reviewed mapping from provider vocabulary, such as a product-line/category id, set id, or set name, to one Catalog Scope Record
- `Scope Coverage` — the read model answer showing which provider units can cover a Catalog Scope Record and which mappings or provider capabilities are missing
- `Scope Sync` — the workflow that starts from a Catalog Scope Record, applies approved Provider Scope Mappings, and then plans provider pulls
- `Scope Sync Batch` — a durable, bounded Catalog workflow that previews and executes Scope Sync across explicit or server-resolved matching Catalog Scope Records while preserving per-scope planning, provider budgets, stale-evidence checks, and settled work
- `Provider Participation Preview` — a unit-aware pre-sync answer showing which provider units can participate in a Catalog Sync Scope, which are required or optional, why they are eligible or blocked, and which child Source Observation execution scope each selected unit would use
- `Product Asset Set` — the Catalog-owned normalized set of WebP image variants derived from one source image for a Catalog Item or Source Observation
- `Asset Variant` — one generated WebP file in a Product Asset Set, identified by role, pixel dimensions, device-pixel-ratio target, storage key, byte size, and public URL
- `Source Asset` — the highest-quality imported image retained for provenance and future variant regeneration
- `Reference Type` — a reusable kind of rich descriptive value, such as Expansion, Set, Series, or Product Line
- `Reference Record` — one rich reusable value under a Reference Type, such as Ascended Heroes under Expansion or Time Spiral under Set
- `Display Template` — a reusable rule that resolves Catalog Item title and subtitle copy from Fields, Reference Records, Categories, Blueprints, or item-specific overrides
- `Resolved Display Identity` — the Catalog-owned item-level title/subtitle fact produced from Display Templates and fallback metadata for downstream consumption
- `External Catalog Item Reference` — a provider-scoped product identifier mapped to one Catalog Item
- `External Product Reference` — a provider-scoped SKU or sellable identifier mapped to one Catalog Item plus selected Options for Product resolution
- `Provider Integration Profile` — Catalog-owned configuration that defines how one provider's observations, lookup scopes, normalized facts, Catalog mappings, external references, and ambiguity rules are interpreted
- `Catalog Item Image Fallback` — the configured fallback image for a Catalog Item, including whether it is permanent item imagery or loading-only presentation imagery
- `Product Measure Profile` — a reusable Catalog-owned physical measurement rule for Products that share size, weight, stack behavior, and physical flags
- `Resolved Product Measure` — the per-Product measurement snapshot published for downstream shipping quote and fulfillment use
- `Product Contents` — the Catalog-owned relationship describing what one configured Product contains
- `Product Content Line` — one contained Catalog Item or Product selection inside Product Contents
- `Product Content Type` — configured Catalog data that names and orders the meaning of a Product Content Line
- `Product Content Inclusion Policy` — configured Catalog data that describes exact, variable, random, optional, choice-based, or other inclusion semantics

These are Catalog concepts, not compatibility aliases. They support authoring catalog truth while `Catalog Item`, `Dimension`, `Option`, and `Product` define catalog identity.

## Rich Reference Model

Use a `Reference Record` when a field value needs its own durable identity, attributes, or relationships. For example, a Pokemon TCG Expansion or Magic: The Gathering Set is not just text on every card. It can be a Reference Record with card count, release date, abbreviation or set code, source ID, and a relationship to a Series or Product Line Reference Record.

Reference Record relationships may form a hierarchy. For example, an Expansion can point to a Series, the Series can point to a TCG/Product Line, and the TCG/Product Line can point to a Manufacturer. Catalog Items should select the most specific applicable Reference Record and inherit broader reusable facts through that hierarchy.

Reference Records enrich Catalog Item information. They do not create Product variation and do not affect Product identity unless a Blueprint separately models variation through Dimensions and Options.

## Scope Registry Model

A `Catalog Scope Record` is the canonical sync-facing projection of a Reference Record. Product-line, Series, Expansion, and Set Reference Records can become scope records for `pokemon`, `magic`, `yugioh`, `one-piece`, and `lorcana`. Pokemon uses `expansion` for leaf scope records; Magic, Yu-Gi-Oh!, One Piece, and Lorcana use `set`.

Expansion and set scope records carry canonical `release-date`, `official-set-code`, and `language-editions` attributes. Provider ids, provider category ids, provider set names, and provider-local aliases are not the Scope Record identity. They belong to Provider Scope Mapping.

`Scope Coverage` and `Scope Sync` are follow-on read/workflow concepts. They must consume Catalog Scope Records and reviewed Provider Scope Mappings instead of rebuilding scope identity from provider hints.

## Provider Scope Mapping

A `Provider Scope Mapping` is a reviewed, Catalog-owned mapping from provider vocabulary — a product-line or category id, set id, or set name — to exactly one Catalog Scope Record. Mappings carry review status and provenance; Scope Sync consumes only approved mappings and never rebuilds scope identity from provider hints.

## Scope Sync Batch

A `Scope Sync Batch` is Catalog-owned orchestration over existing Scope Sync Runs. Its preview resolves active Catalog Scope Records, accepted or auto-accepted Provider Scope Mappings, active production-capable Provider Integration Profile units, rollout and credential readiness, provider transport authority, and request or credit evidence. Confirmation re-resolves that evidence and fails closed when its plan fingerprint changes.

The batch advances a bounded number of scope units per leased worker turn. It never fans out the complete catalog in one request and never creates a provider-specific execution shortcut. Completed units remain completed through cancel, resume, and failed-unit retry; an unchanged settled fingerprint is a fast no-op.

## Production Catalog Completion Report

A `Production Catalog Completion Report` is the versioned, Catalog-owned contract and verifier that decides whether a production Catalog synchronization is complete, reconciled, and convergent. It reconciles a frozen Scope Sync Batch completion manifest against a launch cutoff: eligible Catalog Scope Records and accepted Provider Scope Mappings, expected versus planned provider units, per-unit terminal state after the cutoff, Source Observation and merge-candidate dispositions, promotion outcomes, intended launch Catalog Item counts, approved asset-processing failures, and credited-provider usage. Completeness is derived from the manifest and never inferred from a hardcoded provider list.

Every scope or provider unit excluded from required coverage carries one stable reason — `ineligible`, `validation-only`, `comparison-only`, `unapproved`, `retired`, `rollout-blocked`, `provider-unavailable`, `mapping-missing`, or `operator-deferred`. Missing mappings, never-synced or stale or failed units, unresolved merge conflicts, duplicate-prevention blocks, blocked promotions, and unexplained exclusions are launch blockers. Repeat-run reconciliation compares a re-execution against the accepted manifest and fails on duplicate Catalog truth, a changed plan fingerprint, or unexpected new work. The retained ops verifier emits support-safe JSON plus a human summary and exits nonzero for any launch blocker.

## Provider Scope Observation

A `Provider Scope Observation` records the provider, ingestion unit, scope kind, external id, label, parent coordinates, language, provider metadata, and deterministic hash returned by an option sync. Observations are provider evidence, not canonical Scope Records. The matcher may auto-accept a unique exact canonical match, propose ambiguous mappings, or create one reviewable canonical Scope Record proposal for unmatched evidence. Accepted, rejected, and revoked mapping dispositions survive later observation refreshes.

## Alias Model

A `Catalog Alias` is reviewable item-level evidence that a piece of text refers to a Catalog Item: an official equivalent in another language or market, a translation, a provider-localized name, a species name, a romanization, or a generated translation. Translation is one kind of alias, not the whole model.

`Catalog Alias` is a distinct concept from the two provider-configuration synonym terms below. A Catalog Alias is reviewable evidence with a type, a confidence, and a review status; the synonym terms are deterministic provider configuration. See [Catalog Alias Vocabulary And Ownership ADR](./docs/catalog-alias-vocabulary-adr.md) for ownership, the auto-accept boundary, revocation semantics, edge cases, and the milestone delivery map.

Alias concepts:

- `Catalog Alias` — an accepted, published fact that a piece of text refers to one or more Catalog Items, carrying its `Alias Type`, `Alias Confidence`, language, and source.
- `Alias Candidate` — a proposed alias awaiting or undergoing review. It becomes a `Catalog Alias` only when its `Alias Review Status` reaches `accepted` or `auto-accepted`.
- `Alias Type` — the kind of equivalence the alias asserts. Initial set: `official-equivalent`, `provider-localized-name`, `species-name`, `literal-translation`, `romanization`, `generated-translation`, `set-equivalent`, `series-equivalent`. `set-equivalent` and `series-equivalent` operate at the Reference Record level; the rest operate at the Catalog Item level.
- `Alias Confidence` — how trustworthy the alias is, independent of type. Initial set: `exact`, `high`, `candidate`, `generated`, `manual`.
- `Alias Review Status` — the alias lifecycle. Initial set: `pending`, `accepted`, `rejected`, `auto-accepted`, `revoked`. `rejected` was never trusted; `revoked` was previously trusted and is being withdrawn, which triggers downstream removal.

Provider-configuration synonym terms (distinct from `Catalog Alias`, renamed to free the word `alias`):

- `Provider Option Query Key Synonym` — an alternate key that resolves to the same provider option query, expressed in code as `CatalogProviderOptionQuery.queryKeySynonyms`. For example, the query keyed `"languages"` also answers to `"language"`. These are deterministic key synonyms, not aliases.
- `Provider Option Value Synonym` — a mapping of provider value text to a canonical option key, expressed in code as `CatalogProviderSelectedOptionValueSynonym` within `valueSynonyms`. For example, the provider values `"Holo"` and `"Foil"` both map to the `"holofoil"` option key. These are deterministic value synonyms, not aliases.

Cardinality: one alias text may map to many Catalog Items (species names, alt arts, regional variants) and one Catalog Item may carry many aliases across languages, providers, and types. Catalog publishes the cardinality signal so Discovery can down-weight broad aliases and dedupe by `catalog_item_id`; a broad alias never floods or outranks a precise item match, and an alias never replaces the Resolved Display Identity as the primary label.

Ownership: Catalog owns alias facts, review, confidence, revocation, and the auto-accept boundary. Discovery consumes published alias facts into its search projection and never re-derives them from provider data. This follows the Resolved Display Identity boundary.

## Product Resolution Model

The current implementation resolves valid Product combinations through blueprint-driven rules. Catalog remains the owner of Product identity and selection validity; downstream contexts consume resolved Product data instead of deciding whether option combinations are valid.

Product identity is the tuple `(catalogItemId, selectedOptions)`. A Product is not an independently persisted aggregate and does not have a minted first-class `ProductId`.

### Product Key

`ProductKey` is the deterministic scalar derived from a Product's `catalogItemId` and normalized `selectedOptions`. It is a display and selection lookup key, not standalone Product identity. Existing API, storage, and append-only event payloads retain the field name `productId`; at the type level that field carries `ProductKey` so its derived role is explicit without renaming historical wire data.

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
- A `Catalog Sync Scope` may plan one or more provider-unit Source Observation pulls.
- A `Scope Sync Batch` contains one durable unit per selected Catalog Scope Record and composes one existing Scope Sync Run per unit.
- A `Catalog Scope Record` belongs to one product domain and points at one Reference Record.
- A `Provider Scope Mapping` points provider vocabulary at one Catalog Scope Record.
- A `Provider Participation Preview` belongs to one Catalog Sync Scope and resolves selected providers into child `SourceObservationIntegrationJobScope` values.
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
- Product Contents belongs to one container Catalog Item or Product selection and contains zero or more Product Content Lines.
- A Product Content Line may point at a contained Catalog Item, a contained Product selection, or unresolved provider evidence awaiting Catalog review.

## Identity and IDs

These are the canonical snake_case column names in Catalog SQL schemas and durable wire read-model rows. TypeScript, JSON API bodies, MCP arguments, and event payloads use the camelCase form of the same identifiers instead (`catalogItemId`, `productId`, `dimensionId`, and so on) — see [Identifier Conventions](../../docs/architecture/identifier-conventions.md) for the full camelCase-vs-snake_case scope rule.

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `reference_type_id`
- `reference_record_id`
- `scope_record_id`

## Natural-Key Normalization

Natural keys are normalized once at Source Observation ingest before they are persisted or used for Catalog identity and duplicate prevention. Existing stored external keys remain append-only history; this contract governs new observations and replayed mapping output.

| Field | Normal form | Scope |
| --- | --- | --- |
| `setCode` | Trimmed lowercase | Set codes are case-insensitive, including Magic `TSP` → `tsp`. |
| `cardNumber` | Trimmed; numeric-only values use their unpadded form | `0136` → `136`; alphanumeric or composite game-significant numbers retain their formatting. |
| `collectorNumber` | Trimmed; numeric-only values use their unpadded form | `0136` → `136`; alphanumeric or composite game-significant numbers retain their formatting. |
| `languageCode` | Canonical BCP-47 language tag | Uses the shared locale contract, such as `EN-us` → `en-US`. |
| `providerKey` | Trimmed lowercase | Provider identity is case-insensitive. |
| `externalKey` | Trimmed and otherwise preserved exactly as provider-issued | External identifiers are provider-owned and may be case/format significant. |

The promotion command planner and duplicate-prevention resolver use the same `languageCode:externalKey` composition after this normalization. Natural-key normalization does not rewrite historical event or reference keys.

Notes:

- `product_id` carries the derived `ProductKey` for a catalog-defined Product selection, not a first-class Product identifier, listing, inventory item, or physical item.
- Canonical Product identity is `(catalog_item_id, selected_options)`.
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

- Product Contents command inputs use `catalog_item_id` plus `selected_options`; `product_id` is derived in validation, projections, or read models.
- Product-line-specific content meanings belong in Product Content Type and Inclusion Policy configuration, not Catalog domain enums.
- Product Contents must not create cycles in the accepted resolved graph.

## SQL and Storage Field Guidance

This section names SQL columns and durable wire read-model row fields — not JSON API, command, or event payload fields. See [Identifier Conventions](../../docs/architecture/identifier-conventions.md): APIs, commands, and events use the camelCase form of every name below (`catalogItemId`, `productId`, `dimensionId`, `selectedOptions`, and so on).

Preferred SQL/storage field names:

- `catalog_item_id`
- `product_id`
- `dimension_id`
- `option_id`
- `selected_options`
- `product_schema`
- `product_summary`
- `reference_type_id`
- `reference_record_id`
- `scope_record_id`
- `display_template_id`
- `display_identity_hash`
- `provider_key`
- `external_key`
- `product_content_type_id`
- `product_content_inclusion_policy_id`

Avoid:

- `item_id`
- `entry_id`
- `catalog_version_key`
- `version_selection`
- `version_schema`
- `version_summary`

Canonical selection shape (camelCase, as sent/received over the API and stored in commands/events):

```json
[
  {
    "dimensionId": "dim_form",
    "optionId": "opt_graded"
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
- semantic Catalog Sync Scopes and provider participation previews before Source Observation provider jobs run
- Catalog Scope Records that canonicalize sync identity before provider-specific mappings are applied
- the normalized product imagery contract published as Product Asset Sets
- reusable Product Measure Profiles and Resolved Product Measures
- Product Contents and the resolved product-to-product containment fact

Catalog does not define:

- listing aggregation
- multi-select filtering
- faceted search behavior
- shipping quote policy
- package execution
- Discovery ranking, filtering, or presentation of Product Contents

Catalog sync decision vocabulary:

- `split` means one provider-sourced candidate should become more than one Catalog candidate.
- `update` means an approved candidate refreshes existing Catalog Item/Product facts through Catalog commands.
- `delete` means a candidate is rejected, ignored, or withdrawn from the merged candidate set. It is not canonical Catalog Item/Product removal.

## One-Line Summary

A Catalog Item defines the thing, Dimensions define axes of variation, Options define selectable values, and a Product is a valid sellable combination of selected Options under the Catalog Item; Blueprints, Fields, Components, Categories, Reference Types, Reference Records, Display Templates, Resolved Display Identity, Product Measure Profiles, Product Contents, and Catalog Sync Scopes support authoring, enriching, organizing, naming, measuring, relating, and syncing that truth.
