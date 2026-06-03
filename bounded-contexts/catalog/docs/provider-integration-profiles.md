# Provider Integration Profiles

Catalog provider integrations own the Catalog structure required to ingest and promote provider facts.

## Purpose

A provider integration profile is Catalog-owned setup for a product line or provider. It can create or reconcile Fields, Dimensions, Options, Components, Blueprints, Categories, Reference Types, and Reference Records needed by the integration. It also carries the provider semantics used after bootstrap: provider key, label, capabilities, supported scopes, option queries, normalized observation mapping, Catalog field mapping, reference hierarchy mapping, external reference extraction rules, reference target level, and ambiguity rules.

Provider integration profiles are not fake data. They are the authoring structure that lets operators import, review, promote, and publish real provider observations.

Executable mapping semantics are documented in [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md). That contract is the migration target for profile versions, selectors, transforms, normalized Source Observation output, hash material, merge identity, external references, selected Options, Reference Record hierarchy, duplicate-prevention rules, and Catalog aggregate promotion command plans. Provider transport adapters should fetch provider payloads only; Catalog-owned profile data decides how those payloads become Catalog review facts.

## Versioned Data Path

Catalog persists provider integration profiles in `catalog_provider_integration_profile_versions`.
Each row carries the provider key, profile key, profile version, lifecycle, active flag, profile JSON, source contract metadata, fixture contract metadata, compatibility mode, optional executable mapping contract, and optional retirement plan.

The current TCGdex and TCGplayer profiles are seeded through this versioned data path during Catalog bootstrap. They remain available through transitional static compatibility exports only so existing Source Observation runtime code can keep working while the generic mapping interpreter lands. Transitional static profiles must carry fixture coverage and a retirement issue.

Profile lifecycle values are:

- `draft`: authored but not selectable for normal imports.
- `test`: fixture-backed and available for dry-run or explicit non-production validation.
- `active`: the default profile version for new imports.
- `deprecated`: still readable for replay and rollback, but not selected for new imports.
- `retired`: retained only for historical observations that still reference it.

Activating a profile version validates fixture coverage, profile identity, and the executable mapping contract when one is present. Transitional static fixtures are allowed only with an explicit retirement path. New executable profile versions should not rely on static mapping code once their mapping contract can express the required normalization, external reference extraction, selected Option resolution, Reference Record hierarchy, duplicate-prevention policy, and promotion command plan.

Rollback means activating a prior validated profile version and deprecating the currently active version. It does not edit or delete historical profile rows. Source Observations should continue to record the profile version that produced their normalized data so replay can use the same version by default and operator-initiated reapply can explicitly choose the current active version.

## TCGdex Pokemon TCG Profile

The TCGdex Pokemon TCG profile is seeded in Catalog config and installs the Pokemon card and sealed-product structure used by TCGdex Source Observations:

- card identity Fields such as Card Number, Card Name, Expansion, Rarity, Card Illustrator, and Release Year
- product-resolution Dimensions such as Form, Condition, Grading Company, and Grade
- Pokemon TCG Components and Blueprints
- Pokemon TCG Categories
- Reference Types and Reference Records for Manufacturer, Product Line, Series, and Expansion
- provider options for language, Series, and Expansion selection
- provider endpoint templates for the small TCGdex JSON connector
- TCGdex variant rules, such as `normal` -> `Standard Set` and `reverse` -> `Parallel Set - Reverse Foil`
- TCGplayer and Cardmarket Product ID extraction rules for Catalog Item-level references

Expansion Reference Records may carry `printed-card-count` when the number printed on cards differs from the provider's official count or when promo-style numbering should omit a denominator.

TCGdex imports still write Source Observations. Promotion remains a Catalog review action. Staging and production do not auto-import provider content during bootstrap.

The TCGdex connector must stay transport-only: it fetches TCGdex JSON from profile-defined endpoints. It must not decide which provider fields are Catalog fields, which identifiers are Catalog Item references, which identifiers are Product SKU references, or how duplicate marketplace identifiers are handled.

Reference hierarchy provisioning is profile-driven. The TCGdex profile declares
Reference Types for Manufacturer, Product Line, Series, and Expansion, static
root Reference Records for The Pokemon Company International and Pokemon TCG,
and provider-derived Series and Expansion records using TCGdex provider
attributes. Replays preserve the existing deterministic `ref_tcgdex_*` record
ids and reuse records by type/key or provider attribute.

Catalog Item promotion planning is profile-driven at the same boundary. The
current TCGdex Pokemon planner converts normalized Source Observation facts plus
resolved profile Catalog IDs into a reviewed command plan before the runtime
writes Catalog Item aggregate commands. The plan covers create-vs-refresh,
blueprint assignment, category assignment, field values, tags, image URL and
Product Asset Set commands, source Product references, and external Catalog Item
references.

Duplicate prevention is profile-driven and ordered. The TCGdex profile first
checks exact external Catalog Item references such as TCGplayer Product IDs,
then source observation links, deterministic Pokemon card fields, and finally a
partial-draft retry rule. Ambiguous reusable matches block automatic promotion.

## TCGplayer Automation Client Profile

The TCGplayer integration uses the client contract documented in
[TCGplayer Automation Client Contract](./tcgplayer-automation-client-contract.md).
That contract, not the official TCGplayer API docs, is the source of truth for
provider domains, cookie auth, throttling, endpoint paths, and response concepts
in this workstream.

The TCGplayer profile should model product lines, set names, product search,
product details, category filters, and SKUs from the automation app. It should
map TCGplayer Product IDs to Catalog Item-level external references and
TCGplayer SKUs/productConditionIds to Product-level external references only
when condition, variant/printing, and language can be mapped to valid selected
Options.

TCGplayer SKU selected Options are profile-driven: each mapped dimension defines
the provider evidence path, requiredness, unknown-value policy, provider aliases,
and product-form value mapping. Runtime code resolves those rules against the
active Product schema before an external Product reference can be published.
Unknown, inactive, or missing selected-option evidence remains review evidence.

The TCGplayer profile can represent product-line and set-name Reference Record
evidence through the same hierarchy rules, including `tcgplayer-product-line-id`
and `tcgplayer-set-name` attributes. The connector remains planned until the
broader TCGplayer mapping migration is complete. TCGplayer provider-product
Source Observations remain non-promotable until the active profile declares
Catalog Item promotion capability and a valid promotion command plan. Its
duplicate-prevention mapping still records review-only identity evidence such as
sealed product form, barcode/GTIN values, and future bridge provider references.

## Future Integrations

Future TCG integrations should add their own provider integration profile when their structure differs from Pokemon TCG. Do not place integration-specific fields or blueprints in deployables, and do not make scenario data the source of structural truth.

Each profile should define:

- provider key and supported lookup/import scopes
- provider label and capabilities
- option query definitions and parent scope requirements
- required Fields and value types
- reusable Reference Types and Reference Records
- reference hierarchy rules for static roots, provider-derived records, attributes, and relationships
- Dimensions and Options that affect product identity
- Components and Blueprints used to author and resolve Products
- Categories used for browse grouping
- external reference extraction rules and item-level vs product-level target
- selected-option mapping rules for Product-level external references
- ambiguity rules for repeated or incomplete provider identifiers
- promotion mapping from normalized provider observations into Catalog Item commands

## Boundary

Catalog owns provider integration profiles. Discovery, Inventory, Marketplace, Checkout, Ordering, Pricing, and other downstream contexts consume promoted Catalog facts and resolved Product structure; they do not own provider structure.
