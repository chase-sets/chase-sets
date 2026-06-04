# Provider Integration Profiles

Catalog provider integrations own the Catalog structure required to ingest and promote provider facts.

## Purpose

A provider integration profile is Catalog-owned setup for a product line or provider. It can create or reconcile Fields, Dimensions, Options, Components, Blueprints, Categories, Reference Types, and Reference Records needed by the integration. It also carries the provider semantics used after bootstrap: provider key, label, capabilities, supported scopes, option queries, normalized observation mapping, Catalog field mapping, reference hierarchy mapping, external reference extraction rules, reference target level, and ambiguity rules.

Provider integration profiles are not fake data. They are the authoring structure that lets operators import, review, promote, and publish real provider observations.

Executable mapping semantics are documented in [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md). That contract is the migration target for profile versions, selectors, transforms, normalized Source Observation output, hash material, merge identity, external references, selected Options, Reference Record hierarchy, duplicate-prevention rules, and Catalog aggregate promotion command plans. Provider transport adapters should fetch provider payloads only; Catalog-owned profile data decides how those payloads become Catalog review facts.

## Versioned Data Path

Catalog persists provider integration profiles in `catalog_provider_integration_profile_versions`.
Each row carries the provider key, profile key, profile version, lifecycle, active flag, profile JSON, source contract metadata, fixture contract metadata, compatibility mode, optional executable mapping contract, and optional retirement plan.
Admin-authored rows also carry migration evidence and authoring audit metadata so operators can see who cloned or changed a version and what replay or fixture evidence justified activation.

The current TCGdex and TCGplayer profiles are seeded through this versioned data path during Catalog bootstrap. TCGdex is active as an executable mapping profile version. TCGplayer is fixture-backed as an executable `test` profile version while its automation-client import workflows remain planned. Transitional static profiles must carry fixture coverage and a retirement issue.

Profile lifecycle values are:

- `draft`: authored but not selectable for normal imports.
- `test`: fixture-backed and available for dry-run or explicit non-production validation.
- `active`: the default profile version for new imports.
- `deprecated`: still readable for replay and rollback, but not selected for new imports.
- `retired`: retained only for historical observations that still reference it.

Activating a profile version validates fixture coverage, profile identity, and the executable mapping contract when one is present. Transitional static fixtures are allowed only with an explicit retirement path. New executable profile versions should not rely on static mapping code once their mapping contract can express the required normalization, external reference extraction, selected Option resolution, Reference Record hierarchy, duplicate-prevention policy, and promotion command plan.

Admin activation is guarded by the fixture harness and migration evidence. The activation request returns structured diagnostics when fixture coverage, mapping identity, redaction, or migration evidence is incomplete. Activation must not make live provider calls; fixtures and committed profile data are the only allowed evidence for this gate.

Rollback means activating a prior validated profile version and deprecating the currently active version. It does not edit or delete historical profile rows. Source Observations should continue to record the profile version that produced their normalized data so replay can use the same version by default and operator-initiated reapply can explicitly choose the current active version.

Retirement is stricter than deprecation. A profile version can be retired only after no Source Observations reference it as either their source profile version or promotion profile version. Retired versions remain readable for historical review but cannot be activated for new imports.

Bootstrap seeds static profile rows only as initial or reconciliation data. It preserves admin-authored rows with migration evidence or authoring audit metadata, then verifies that each seeded active provider still has an active persisted row. If an operator edits or retires the seeded active version without activating a replacement, bootstrap fails loudly instead of letting imports fall back to static runtime config.

Durable import jobs snapshot provider key, profile key, profile version, lifecycle, and source mapping fingerprint at enqueue time. Retries and worker handoff reload that snapshotted profile version, so activating a newer version while a job is queued does not change what the queued job writes. Integration reapply jobs snapshot `current-active-profile` mode and the active profile version; direct replay-style reapply uses the Source Observation's original source profile version when available, with legacy rows falling back to the active promotion profile.

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

The active TCGdex profile version carries an executable mapping contract for Source Observation IDs, external keys, normalized Pokemon card facts, source hash material, merge identity, external reference evidence, duplicate-prevention evidence, reference hierarchy evidence, and promotion command-plan intent. The TCGdex connector must stay transport-only: it fetches TCGdex JSON from profile-defined endpoints and assembles the reviewed runtime context consumed by that contract. It must not decide which provider fields are Catalog fields, which identifiers are Catalog Item references, which identifiers are Product SKU references, or how duplicate marketplace identifiers are handled.

TCGdex variant expansion, marketplace reference extraction, Pokemon Reference Record hierarchy provisioning, and Pokemon Catalog Item promotion planning still use reviewed named runtime helpers where generic profile interpretation cannot yet express the behavior safely. Those helpers are transitional compatibility points referenced by the executable mapping contract and provider profile data; they must remain deterministic, fixture-backed, and free of live provider calls.

Provider option queries are profile-driven. The TCGdex profile declares language,
Series, and Expansion query aliases, parent value policy, named transport
operations, and option DTO output selectors. Runtime supplies the named TCGdex
transport operations; profile data decides which operation and mapping are used.

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

The TCGplayer profile models product lines, set names, product search, product
details, category filters, and SKUs from the automation app. Its executable
provider-product mapping contract covers Source Observation IDs, Product ID
external keys, normalized provider-product facts, hash material, merge identity,
Product ID Catalog Item references, SKU Product reference evidence, selected
Option review evidence, product form, barcode/GTIN evidence, duplicate-prevention
evidence, and Reference Record hierarchy evidence. It maps TCGplayer Product IDs
to Catalog Item-level external references and TCGplayer SKUs/productConditionIds
to Product-level external references only when condition, variant/printing, and
language can be mapped to valid selected Options.

TCGplayer option queries use the same profile-driven resolver. Product line and
set-name queries declare legacy aliases such as `categories` and `sets`,
required parent values, named automation-client operations, and constrained
output selectors. Product and SKU query definitions are represented in profile
data for future runtime transports.

TCGplayer SKU selected Options are profile-driven: each mapped dimension defines
the provider evidence path, requiredness, unknown-value policy, provider aliases,
and product-form value mapping. Runtime code resolves those rules against the
active Product schema before an external Product reference can be published.
Unknown, inactive, or missing selected-option evidence remains review evidence.

The TCGplayer profile can represent product-line and set-name Reference Record
evidence through the same hierarchy rules, including `tcgplayer-product-line-id`
and `tcgplayer-set-name` attributes. The connector remains planned until the
broader TCGplayer import workflow is enabled. TCGplayer provider-product Source
Observations remain non-promotable until an active profile declares Catalog Item
promotion capability and a valid promotion command plan. Its duplicate-prevention
mapping still records review-only identity evidence such as sealed product form,
barcode/GTIN values, and future bridge provider references.

The automation client remains transport-owned code for cookie authentication,
domain-specific HTTP clients, throttling, pagination, endpoint DTOs, and response
shape audit fixtures. Runtime DTO adaptation may still assemble deterministic
product-form, barcode, source hash, and selected-option context before invoking
the profile contract; those helpers are not allowed to import price, listing,
seller, inventory, order, or message facts into Catalog truth or hash material.

## Scrydex Scryfall-Style Proof Profile

The Scrydex profile is a planned, fixture-backed proof profile for
Scryfall-style card payloads. It exists to validate the provider mapping
framework's extensibility before a live Scrydex transport adapter is accepted.
It does not add runtime provider branches and does not declare Catalog Item
promotion capability.

The executable Scrydex profile maps raw card payload evidence such as Scryfall
ID, set code, set name, collector number, language, image URLs, and
`tcgplayer_id` into a provider-product Source Observation. The `tcgplayer_id`
is converted by profile config into the existing TCGplayer Catalog Item
reference strategy: `providerKey: "tcgplayer"` and `externalKey:
"product:<tcgplayer_id>"`. Duplicate prevention then uses the shared exact
external Catalog Item reference rule before any review-only bridge evidence,
which lets Scrydex supplement existing TCGdex or TCGplayer observations without
creating duplicate Catalog Items.

Scrydex fixtures deliberately exclude price, seller, inventory, ruling, and
legality facts from Catalog truth and hash material. Those facts may belong in
other bounded contexts or later reviewed integrations, but they are not part of
this Catalog identity proof.

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
