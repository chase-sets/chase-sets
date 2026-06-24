# Provider Integration Profiles

Catalog provider integrations own the Catalog structure required to ingest and promote provider facts.

## Purpose

A provider integration profile is Catalog-owned setup for a product line or provider. It can create or reconcile Fields, Dimensions, Options, Components, Blueprints, Categories, Reference Types, and Reference Records needed by the integration. It also carries the provider semantics used after bootstrap: provider key, label, capabilities, supported scopes, option queries, normalized observation mapping, Catalog field mapping, reference hierarchy mapping, external reference extraction rules, reference target level, and ambiguity rules.

Provider integration profiles are not fake data. They are the authoring structure that lets operators import, review, promote, and publish real provider observations.

Executable mapping semantics are documented in [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md). The overall control-plane boundary is documented in [Catalog Integration Control Plane](./catalog-integration-control-plane.md). That contract is the clean launch target for profile versions, selectors, transforms, normalized Source Observation output, hash material, merge identity, external references, selected Options, Reference Record hierarchy, duplicate-prevention rules, and Catalog aggregate promotion command plans. Provider transport adapters should fetch provider payloads only; Catalog-owned profile data decides how those payloads become Catalog review facts.

The operator-facing workflow is documented in [Provider Integration Admin Module](./provider-integration-admin-module.md). Normal profile authoring, validation, dry-run, comparison, activation, import, promotion/reapply, rollback, migration-evidence, and retirement workflows must be typed and guided in admin. Operators should not need to edit raw JSON to complete supported work.

Idempotency, lifecycle concurrency, retry/resume, partial-failure, and deploy-skew guarantees are documented in [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md). Schema versioning, launched-data compatibility, and resettable pre-launch data policy are documented in [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md). Provider payload, fixture, dry-run, diagnostics, audit, logging, export, and policy/legal review and approval rules are documented in [Catalog Integration Data Governance](./catalog-integration-data-governance.md). Fixture storage, provenance, sampling, coverage sufficiency, validation inputs, and activation-readiness behavior are documented in [Catalog Integration Fixture Lifecycle](./catalog-integration-fixture-lifecycle.md). Activation, rollback, retirement, replay, and reapply workload previews are documented in [Catalog Integration Impact Analysis](./catalog-integration-impact-analysis.md). The executable pre-launch wipe/rebuild and rollback plan is documented in [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md). The cleanup inventory is documented in [Catalog Integration Legacy Cleanup](./catalog-integration-legacy-cleanup.md). First-slice provider proof criteria, transport reliability categories, selected proof provider, and performance budgets are documented in [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md).

## Versioned Data Path

Catalog persists provider integration profiles in `catalog_provider_integration_profile_versions`.
Each row carries the provider key, profile key, profile version, ingestion-unit key, lifecycle, active flag, profile JSON, source contract metadata, fixture contract metadata, optional executable mapping contract, and optional retirement plan.
Admin-authored rows also carry migration evidence and authoring audit metadata so operators can see who cloned or changed a version and what replay or fixture evidence justified activation.

Current production and proof profiles are seeded through this versioned data path during Catalog bootstrap. Active production import/reference units include TCGdex Pokemon, TCGplayer Magic, MTGJSON, Scryfall, Scrydex One Piece, and TCGplayer One Piece units when their source authority gates are accepted. Fixture-backed `test` profile versions remain explicit non-production contract evidence only.

Profile lifecycle values are:

- `draft`: authored but not selectable for normal imports.
- `test`: fixture-backed and available for dry-run or explicit non-production validation.
- `active`: the default profile version for new imports.
- `deprecated`: still readable for replay and rollback, but not selected for new imports.
- `retired`: retained only for historical observations that still reference it.

Activating a profile version validates fixture coverage, profile identity, ingestion-unit identity, and the executable mapping contract. Profile versions should express normalization, external reference extraction, selected Option resolution, Reference Record hierarchy, duplicate-prevention policy, and promotion command plan through the executable mapping contract.

Active profile selection is unit-aware. A provider may have more than one active profile version when those versions represent different ingestion units, such as separate card, set/reference-data, or image-evidence units. Activating a new version deactivates only competing active versions for the same provider profile key or ingestion-unit key; unrelated active units for the same provider remain active. Provider-only active lookup is compatibility sugar: it returns the single active unit, returns `null` when none exists, and fails closed with a selector-required diagnostic when multiple active units exist.

Admin activation is guarded by the fixture harness and migration evidence. The activation request returns structured diagnostics when fixture coverage, mapping identity, redaction, or migration evidence is incomplete. Activation must not make live provider calls; fixtures and committed profile data are the only allowed evidence for this gate.

Rollback means activating a prior validated profile version and deprecating the currently active version. It does not edit or delete historical profile rows. Source Observations should continue to record the profile version that produced their normalized data so replay can use the same version by default and operator-initiated reapply can explicitly choose the current active version.

Retirement is stricter than deprecation. A profile version can be retired only after no Source Observations reference it as either their source profile version or promotion profile version. Retired versions remain readable for historical review but cannot be activated for new imports. This profile lifecycle state is not permission to retain unlaunched legacy control-plane code, product patterns, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, operator instructions, flags, aliases, redirects, support-only routes, compatibility shims, or migration shims; retiring those launch-blocking surfaces means complete removal.

Bootstrap seeds static profile rows only as initial or reconciliation data. It preserves admin-authored rows with migration evidence or authoring audit metadata, then verifies that each seeded active provider still has an active persisted row. If an operator edits or retires the seeded active version without activating a replacement, bootstrap fails loudly instead of letting imports fall back to static runtime config.

Pre-launch reset deletes non-admin-authored provider profile rows and then rebuilds the seeded profile versions through this same persisted data path. Admin-authored rows with migration evidence or authoring audit metadata are preserved by default and must have an explicit retained-data reason, removal date, removal criteria, and launch gate before launch if they outlive the reset window.

Durable import jobs snapshot provider key, profile key, profile version, ingestion-unit key, lifecycle, connector kind, connector source version, and source mapping fingerprint at enqueue time. Retries and worker handoff reload that snapshotted profile version, so activating a newer version while a job is queued does not change what the queued job writes. Integration reapply jobs snapshot `current-active-profile` mode and the active profile version for the selected profile/unit; direct replay-style reapply uses the Source Observation's original source profile version and fails closed when that metadata is missing or still carries retired `legacy` markers. Legacy Source Observation profile markers are reset/drop evidence for the pre-launch cleanup gate, not a fallback to the active promotion profile.

Profile version rows use the `catalog-provider-profile-version-v1` launch contract. Referenced active, deprecated, retired, rollback, audit, job, or Source Observation profile versions remain readable through that contract. Unreferenced pre-launch profile rows should be reset or rebuilt by the prelaunch data reset/drop plan instead of gaining permanent compatibility adapters.

Profile edits, activation, rollback, deprecation, and retirement are blocked while same-provider import, reapply, or promote jobs are queued or running. This keeps activation and authoring decisions from racing a worker that is executing against an older snapshot or a review job that may refresh promoted Catalog Items.

## Ingestion-Unit Profile Sections

Catalog-facing profile authoring is organized around ingestion-unit profile sections. The section domain module assembles a versioned provider profile row into named value objects scoped to one ingestion unit:

- ingestion-unit identity
- profile identity and lifecycle
- source contract and fixture contract
- provider options
- connector/adapter binding metadata
- normalized observation mapping and Catalog field mapping
- condition/certification mapping
- external references
- selected Options
- Reference Record hierarchy
- duplicate prevention and ambiguity policy
- promotion plan
- migration evidence
- retirement plan

Every section carries the ingestion-unit key and editability status so Admin Control Plane workflows can reason about a profile without falling back to raw JSON snapshots. The section model is assembled from the existing versioned profile row, then persisted as a deterministic read-model projection for queryability and stale-edit detection.

Ingestion-unit identity uses `providerKey:productDomain:productForm:ingestionPurpose` for provider profile versions. Current seeded Source Observation profiles include `tcgdex:pokemon:single-card:source-observation-import`, `tcgplayer:mtg:single-card:source-observation-import`, `mtgjson:mtg:set:reference-data`, `mtgjson:mtg:single-card:reference-data`, `scryfall:mtg:single-card:reference-data`, and `scryfall:mtg:single-card:image-evidence`. The older `tcgplayer:pokemon:single-card:source-observation-import` automation profile remains test lifecycle evidence, not the active TCGplayer import unit. Raw and graded card differences stay inside the `single-card` unit as condition/certification or selected Option semantics; they are not separate ingestion units unless a future profile proves a distinct aggregate target, lifecycle, promotion plan, or duplicate-prevention policy.

Lifecycle policy is a Catalog domain decision. Draft and test profile versions are editable and can be evaluated for activation readiness. Active versions can be deprecated. Retirement is stricter: the profile must be inactive, not already retired, and unreferenced by Source Observations. Activation readiness evaluates executable mapping presence, Source Observation import capability, fixture isolation, required fixture coverage, profile validation diagnostics, and migration evidence when a mapping fingerprint change requires it.

Connector binding sections expose metadata only. Provider adapters own auth, domains, endpoint paths, pagination, throttling, retries, cooldowns, raw provider parsing, and other transport behavior. Profile sections may record which transport concerns the adapter owns and which mapping concerns Catalog owns, but they must not move provider transport implementation into Catalog profile data.

Editable section behavior is defined through the Source Observations provider profile section registry. Registry entries own the stable Admin command section key, display metadata, command validation, and patch composition for their section. Adding a new editable section should add a registry entry and focused tests for that definition rather than editing separate central validation and patch switches.

Section rows are persisted as projections in `catalog_provider_profile_version_sections` with matching diagnostics in `catalog_provider_profile_version_section_diagnostics`. The canonical source of truth remains `catalog_provider_integration_profile_versions`; section rows are rebuilt from that snapshot whenever profile versions are seeded, created, updated, activated, deprecated, or retired through the profile version store. Each section row stores the section JSON, validation status, ingestion-unit key, editability flag, last-edit metadata from the authoring audit, and a deterministic `sha256:` fingerprint that Admin workflows can use as a section etag for stale-edit detection.

The projection tables are query/read-model infrastructure, not a new profile authoring source. If a section projection is missing or stale, replaying the canonical provider profile version snapshot must recreate the same section rows and diagnostics.

Normal Admin Control Plane authoring must use section-scoped typed commands, and every editable section metadata entry must report `rawJsonBacked=false`. There is no supported profile-shaped JSON patch route for launch workflows.

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

The active TCGdex profile version carries an executable mapping contract for Source Observation IDs, external keys, normalized Pokemon card facts, source hash material, merge identity, external reference evidence, duplicate-prevention evidence, reference hierarchy evidence, and promotion command-plan intent. The TCGdex ProviderAdapter is the live transport boundary: it lists the `tcgdex:pokemon:single-card:source-observation-import` ingestion unit, serves language/Series/Expansion option queries, plans Expansion import scopes, fetches TCGdex JSON payloads, attaches source provenance, and emits transport diagnostics. It must not decide which provider fields are Catalog fields, which identifiers are Catalog Item references, which identifiers are Product SKU references, or how duplicate marketplace identifiers are handled.

The real-provider proof exercises this profile-backed unit with a redacted proof packet keyed to `tcgdex:pokemon:single-card:source-observation-import`. The packet runs through bounded option queries, TCGdex ProviderAdapter import planning/fetch, the Catalog Integration Engine, Source Observation review summaries, and promotion-preview counts before any Catalog Item write. CI keeps deterministic adapter-response coverage for the same contract; staging/local operator proof uses live or staging TCGdex transport through `pnpm run catalog:real-provider-proof`. Neither path may add provider-specific runtime/API/Admin/promotion branches, raw payload shortcuts, compatibility redirects, support-only retired routes, or retired admin patterns. The current adapter provenance does not include a payload content hash, so readiness and proof evidence document `sourceHash: null` until hash material is implemented against the governed payload and retention policy.

TCGdex variant expansion, marketplace reference extraction, Pokemon Reference Record hierarchy provisioning, and Pokemon Catalog Item promotion planning use reviewed named semantic helpers referenced by the executable mapping contract and provider profile data where generic profile interpretation cannot yet express the behavior safely. These helpers are clean launch extension points only when they are deterministic, fixture-backed, free of live provider calls, and covered by profile contract evidence; they are not retained compatibility branches.

Provider option queries are profile-driven. The TCGdex profile declares language,
Series, and Expansion query aliases, parent value policy, named transport
operations, and option DTO output selectors. Runtime supplies those operations
through the registered TCGdex ProviderAdapter; profile data decides which
operation and mapping are used. Cache keys, TTLs, stale fallback, cursor
pagination, cache-only rollout behavior, and degraded Admin display are governed
by [Catalog Integration Provider Option Query Controls](./catalog-integration-provider-option-query-controls.md).
The first-slice proof budgets select this TCGdex unit as the primary proof
provider; see [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md).

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
and `tcgplayer-set-name` attributes. The TCGplayer Magic single-card profile is
the active production import profile. The ProviderAdapter is the live transport
boundary: it lists the `tcgplayer:mtg:single-card:source-observation-import`
ingestion unit, constrains product-line, set-name, product, and SKU option-query
transport to Magic single-card products, plans Product and Set Name import
scopes, fetches automation-app Product Detail payloads, attaches source
provenance, and emits credential/session, domain, retry, and rate-limit
diagnostics. Credential storage, validation, rotation, revocation, and readiness
reporting remain adapter-owned according to
[Catalog Integration Credential Readiness](./catalog-integration-credential-readiness.md).
It must not decide which TCGplayer facts are Catalog
Fields, which Product IDs are Catalog Item references, which SKUs are Product
references, or whether a provider-product observation is promotable.

The adapter identifies TCGplayer integration work as narrow ingestion units
rather than one broad provider semantic profile. Implemented active production
units include `tcgplayer:mtg:single-card:source-observation-import`,
`tcgplayer:mtg:sealed-product:source-observation-import`,
`tcgplayer:yugioh:single-card:source-observation-import`,
`tcgplayer:one-piece:single-card:source-observation-import`, and
`tcgplayer:one-piece:sealed-product:source-observation-import`. The Pokemon
automation unit is retained as a test profile for contract coverage. Raw and
graded card differences stay inside the single-card unit as
condition/certification and selected Option evidence unless a future provider
payload proves a distinct aggregate target, lifecycle, duplicate-prevention
policy, or promotion plan.

TCGplayer provider-product Source Observations remain non-promotable until an
active profile declares Catalog Item promotion capability and a valid promotion
command plan. Its duplicate-prevention mapping still records review-only
identity evidence such as sealed product form, barcode/GTIN values, and future
bridge provider references.

For the transport budgets, TCGplayer remains supplemental transport evidence for
credential/session/domain/rate-limit behavior. It must not replace the selected
TCGdex first-slice proof provider until its promotion path is launch-active and
the provider choice is explicitly changed with evidence.

The automation client remains transport-owned code for cookie authentication,
domain-specific HTTP clients, throttling, pagination, endpoint DTOs, and response
shape audit fixtures. Runtime DTO adaptation may assemble deterministic
product-form, barcode, source hash, and selected-option context before invoking
the profile contract only as a reviewed clean launch helper. If a future generic
profile section replaces one of these helpers, the old helper, tests, fixtures,
seeds, documentation, runbooks, release notes, and operator instructions must be
deleted completely. These helpers must not import price, listing, seller,
inventory, order, or message facts into Catalog truth or hash material.

The runtime dispatches TCGplayer import work through the reviewed provider
transport and durable-job boundary. Complete deletion of retired page
or route patterns follows once the rebuilt workbench is accepted. Future generic
executor replacement must remove the replaced branch, tests, fixtures, seeds,
screenshots, documentation, runbooks, release notes, and operator instructions
in the same cleanup, not leave a compatibility alias.

## Scrydex Scryfall-Style Proof Profile

The Scrydex Scryfall-style profile is a fixture-backed `test` profile for
Scryfall-shaped Magic card payloads. It remains only as contract evidence for
the provider mapping framework's extensibility. It is not the production Scrydex
transport path, must not appear as a production import choice, and does not
declare Catalog Item promotion capability.

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

## Scrydex One Piece Production Shape

One Piece production sync uses dedicated active Scrydex One Piece profile units
and the shared Scrydex transport credential. Production-like writes remain gated
until [Catalog Integration One Piece Production Signoff](./catalog-integration-production-signoff.md#one-piece)
is accepted. The live adapter is a provider transport boundary: it owns
Scrydex auth, team id handling, endpoint paths, pagination, throttling, usage
checks, rate limits, credit diagnostics, raw response parsing, and sanitized
transport evidence. Provider profiles and executable mapping contracts own which
Scrydex facts become Source Observation facts, duplicate-prevention evidence,
Reference Records, external references, selected Options, and promotion command
plans.

One Piece Scrydex profile units are narrow ingestion units, not one broad
provider semantic profile:

- `scrydex:one-piece:single-card:source-observation-import`
- `scrydex:one-piece:set:reference-data`
- `scrydex:one-piece:sealed-product:source-observation-import`

No active Scrydex One Piece price-history profile version is seeded for this
milestone. Price-history evidence stays source-authority-gated because Scrydex
exposes it as per-card data and One Piece policy excludes unapproved
price-history bodies from Catalog truth. If a future source-authority decision
approves a bounded price/freshness evidence class, it must add a separate
ingestion unit, bulk/call-budget proof or documented operator-visible fallback,
and tests before runtime import can enable it.

Every Scrydex One Piece unit must follow the bulk-first policy in the One Piece
signoff. Normal imports use paginated list/search or filtered bulk calls with
minimal selected fields. One-call-per-card, one-call-per-variant, and
one-call-per-sealed-product are forbidden normal paths. Any per-record fallback
must be documented, tested, preflighted with call impact, and surfaced to the
operator before execution.

The Scrydex Scryfall-style proof profile remains test-scoped validation
evidence for Scryfall-shaped Magic fixtures only. Production One Piece imports
use the `scrydex:one-piece:*` profile units and must not inherit proof-only
Scryfall fixture language, Admin labels, runbook steps, or promotion semantics.
The active Scrydex One Piece connector is live credentialed transport with
fixture-backed activation evidence; it is not a fixture-only production path.

## Lorcana Production Shape

Disney Lorcana production sync uses active LorcanaJSON, Lorcast, Scrydex, and
TCGplayer Lorcana profile units through the shared product-line-agnostic
importer. Production-like writes remain gated until
[Catalog Integration Lorcana Production Signoff](./catalog-integration-production-signoff.md#lorcana)
is accepted and the #2481 interface-only UAT plus #2486 downstream smoke pass.

Lorcana profile units are narrow ingestion units, not one broad importer branch:

- `lorcanajson:lorcana:single-card:reference-data`
- `lorcanajson:lorcana:set:reference-data`
- `lorcast:lorcana:single-card:reference-data`
- `lorcast:lorcana:set:reference-data`
- `tcgplayer:lorcana:single-card:source-observation-import`
- `tcgplayer:lorcana:sealed-product:source-observation-import`
- `scrydex:lorcana:single-card:source-observation-import`
- `scrydex:lorcana:set:reference-data`

Scrydex Lorcana sealed-product sync is not a production-active unit because
Scrydex Lorcana exposes cards, expansions, and price-history surfaces but no
bulk/list sealed-product endpoint. Lorcana sealed products stay on the existing
TCGplayer automation unit unless Scrydex adds a supported bulk/list surface and
source authority approves activation.

The importer shell must discover these units through generic provider,
product-line, source-scope, and import-purpose metadata. Do not add a Disney
Lorcana-specific importer page, route, panel, operator workaround, or hidden
source URL field. Pokemon, MTG, One Piece, and future product lines must keep
using the same shared source-scope controls.

LorcanaJSON is the preferred free bulk-first reference source for set and card
facts. Lorcast is supplemental and must respect cache/pacing behavior. TCGplayer
Lorcana uses the existing Chase Sets automation provider for marketplace product
ids, SKUs, sealed products, variants, and price-reference evidence; TCGCSV is
not a production provider for this milestone. Scrydex Lorcana uses the shared
Scrydex connector and shared `SCRYDEX_API_KEY`/`SCRYDEX_TEAM_ID` settings once
per environment. No Lorcana-specific or game-specific Scrydex secret may be
introduced.

Every Scrydex Lorcana unit must follow the bulk-first policy in the Lorcana
signoff. Normal imports use paginated list/search or filtered bulk calls with
minimal selected fields. One-call-per-card, one-call-per-variant, and
one-call-per-sealed-product are forbidden normal paths. Any per-record fallback
must be documented, tested, preflighted with call impact, and surfaced to the
operator before execution.

Disney Lorcana/Ravensburger official sources are validation-only references for
set names, release dates, official product lineup, pack counts, card-gallery
presence, and official app references unless a later legal/source-authority
decision explicitly approves ingestion. Their raw text, imagery, scraped
payload bodies, and hidden URLs must not appear in fixtures, logs, PR bodies, or
UAT evidence.

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
