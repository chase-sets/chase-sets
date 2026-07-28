# Provider Integration Mapping Contract

Catalog provider integrations use an executable mapping contract to turn provider payload evidence into Catalog-owned review data and command plans. The broader control-plane boundary is documented in [Catalog Integration Control Plane](./catalog-integration-control-plane.md), and the new-provider architecture benchmark is documented in [Catalog Integration New-Provider Walkthrough](./catalog-integration-new-provider-walkthrough.md).

This contract is the clean launch path for Provider Integration Profiles. It does not replace provider transport adapters. Transport adapters fetch and parse provider payloads. Catalog-owned mapping profiles define what the payload means to Catalog.

## Ownership Boundary

Provider transport adapters own:

- authentication, cookies, user agents, and provider headers
- provider domains and endpoint paths
- provider pagination and throttling
- raw HTTP error handling
- raw provider response parsing

Catalog mapping profiles own:

- normalized Source Observation fields
- Source Observation hash material
- merge identity evidence
- external Catalog Item references
- external Product references and selected Option evidence
- Reference Record hierarchy mapping
- duplicate-prevention and ambiguity policy
- Catalog aggregate promotion command plans

Inventory, Pricing, Marketplace, Ordering, Fulfillment, and other downstream contexts consume promoted Catalog facts. They do not own provider mapping semantics.

## Contract Shape

The schema module lives at:

`bounded-contexts/catalog/features/source-observations/api/provider-integration-mapping-contract.ts`

Each executable mapping profile carries:

- `providerKey`, `profileKey`, `displayName`, and `profileVersion`
- lifecycle state: `draft`, `test`, `active`, `deprecated`, or `retired`
- source contract metadata, including repository commit, fixture version, and owning document
- connector metadata that separates transport-owned behavior from mapping-owned behavior
- fixture coverage for normal, partial, stale, changed, ambiguous, replay, sealed-product, and unknown-option flows
- safe provider payload selectors and named transforms
- normalized observation, hash material, merge identity, external reference, selected option, reference hierarchy, duplicate-prevention, and promotion command-plan sections
- explicit non-goals that block Pricing, Inventory, operations, seller, listing, sales, order, message, and secret material from becoming Catalog truth

## Declarative Config And Reviewed Runtime Functions

Most mapping rules should be declarative:

- read a provider path
- coalesce fallback paths
- map array items
- emit constants
- coerce simple value types
- apply small named string or lookup transforms

Executable provider profiles are the canonical Catalog integration mapping path. Provider adapters may fetch, parse, and shape transport DTOs into the profile's declared fixture payload, but Source Observation normalization, hash material, external references, selected-option evidence, duplicate-prevention evidence, reference hierarchy, replay evidence, and promotion-plan evidence must be owned by the profile contract plus shared interpreters.

Some behavior remains a named reviewed runtime function until the generic interpreter can express it safely. Those named functions must be referenced from profile contracts and covered by local fixtures; they must not reintroduce provider-specific mapping branches inside deployables or transport clients.

Profiles may reference those functions by a stable function key. They may not execute arbitrary code or carry dynamic scripts.

The selector and transform interpreter lives at:

`bounded-contexts/catalog/features/source-observations/api/providers/provider-mapping-interpreter.ts`

Promotion command planning lives at:

`bounded-contexts/catalog/features/source-observations/api/promotion/provider-promotion-command-planner.ts`

The planner returns a reviewed, ordered list of Catalog Item aggregate commands
before runtime execution. Supported command-plan names include create or refresh
metadata, blueprint assignment, category assignment, field values, tags, image
URLs, Product Asset Sets, external Catalog Item references, and external Product
references. Provider-product observations must stay blocked until a profile
declares Catalog Item promotion capability and a valid command plan.

Duplicate-prevention identity rule resolution lives at:

`bounded-contexts/catalog/features/source-observations/api/promotion/provider-duplicate-prevention-resolver.ts`

Profiles order identity rules explicitly. Supported rule kinds include exact
external Catalog Item reference, source observation link, deterministic field
match, sealed product match, barcode/GTIN match, and future provider bridge
match. Rules may reuse a single Catalog Item, block ambiguous automatic
promotion, or return review-only candidate evidence for admin dry runs.

Provider option query resolution lives at:

`bounded-contexts/catalog/features/source-observations/api/providers/provider-option-query-resolver.ts`

Profiles declare query aliases, parent value requirements, named transport
operations, and constrained option output selectors. Runtime supplies transport
operations such as `tcgdex-list-expansions` or `tcgplayer-list-set-names`; the
profile decides which operation and mapping are valid for each provider query.

The interpreter evaluates provider payload evidence only. It returns evidence values with owner, use, and redaction metadata; it does not automatically make output Catalog truth. It supports nested paths, constants, coalescing, templated string assembly, fixed arrays, object selectors, array mapping, string transforms, coercion, lookup tables, and explicitly registered named selectors/transforms. Missing required fields, unresolved template values, unregistered named functions, lookup misses, empty arrays, and type coercion failures return diagnostics that identify the config path and redaction category without including raw provider values.

Profile activation and import preparation validate executable expressions against fixture payloads before import jobs run. Invalid configs fail at validation time, not halfway through a live provider import.

Admin-managed activation must run the local fixture harness for the target profile version. The harness covers the declared normal, partial, stale, changed, ambiguous, replay, sealed-product, and unknown-option flows and must not make live provider calls. Diagnostics must identify the safe config path, fixture flow, severity, and redacted message so operators can fix drafts without storing provider secrets or seller/listing/price/inventory facts.

When a candidate profile changes the source mapping fingerprint from the currently active profile, activation requires durable migration evidence on the profile version. Evidence should summarize the compatibility review, replay policy, and observed before/after impact; it must not include raw provider payloads or sensitive provider material. Rollback reactivates a previously validated version and records fresh lifecycle audit metadata instead of editing historical rows.

## Admin Editing Contract

Admin profile editing uses typed section commands, not arbitrary profile JSON edits, for normal operator workflows. Versioned profile JSONB remains the persistence shape, but the UI and API contract should be domain-shaped:

- section commands identify the edited profile section, command type, and typed payload
- saves preserve immutable provider/profile/version identity and unknown future-compatible profile data
- validation returns diagnostics with section/control paths that can be pinned to guided controls
- lifecycle-sensitive commands respect draft, test, active, deprecated, and retired constraints
- unsafe evidence categories block normalized output, hash material, merge identity, duplicate-prevention identity, promotion command inputs, and activation
- raw JSON patching is not a launch workflow; every normal authoring section uses typed commands, and any read-only support inspection path must stay separate from profile mutation

The admin module workflow and no-raw-JSON policy are documented in [Provider Integration Admin Module](./provider-integration-admin-module.md).

## Lifecycle

- `draft`: authored but not eligible for import jobs.
- `test`: fixture-backed and usable in validation, dry runs, and explicit non-production jobs.
- `active`: the default profile version for new import jobs.
- `deprecated`: retained for replay or rollback, but not selected for new imports.
- `retired`: retained only for historical Source Observation review and cannot be selected for new imports.

Activating a profile version must validate the schema, fixture coverage, unsafe evidence use, required mappings, and redaction policy before import jobs run.

Catalog API reads require `catalog.view`; profile authoring, lifecycle changes, production imports, promotion, reapply, rollback, and retirement require `catalog.manage` at the API host boundary and at the Catalog-owned control-plane route boundary. New dry-run submissions and POST-based impact/preview requests are also `catalog.manage` operations because they prepare or evaluate privileged follow-up work. Profile rows persist authoring audit metadata for actor, account, and timestamp evidence. Lifecycle diagnostics and dry-run output must keep sensitive provider material redacted in API responses, logs, and UI. The action matrix is documented in [Catalog Integration Admin Control Plane RBAC](./catalog-integration-admin-control-plane-rbac.md).

## Replay And Reapply Determinism

Source Observations should record the profile version that produced their normalized data and hash material. Replaying or reapplying a Source Observation must be deterministic:

- default replay uses the same profile version that produced the observation
- operator-initiated reapply may use the currently active profile version
- deprecated and retired profile versions remain readable for referenced observations; missing or retired `legacy` markers fail closed and are reset/drop evidence, not a fallback to the current active profile
- rollback means reactivating a prior validated profile version, not editing history in place

## Provider Coverage

The contract must support:

- TCGdex Pokemon TCG observations, marketplace Product ID extraction, variant mapping, Reference Record hierarchy, and Pokemon card promotion
- TCGplayer automation-app product lines, set names, product details, Product IDs, SKUs, selected Option evidence, and explicit exclusion of price, listing, seller, order, message, and seller inventory facts
- Scrydex/Scryfall-style payloads that carry `tcgplayer_id` evidence for duplicate prevention without importing non-Catalog facts as Catalog truth

## Non-Goals

- No live provider calls in mapping tests.
- No Pricing facts as Catalog truth.
- No Inventory row facts as global Catalog truth.
- No provider secrets in events, logs, Source Observations, committed config, or fixtures.
- No provider transport branches in the generic mapping interpreter.

## Migration Path

1. Define the executable contract and validation diagnostics.
2. Persist provider profiles as versioned Catalog-owned data.
3. Build the safe selector and transform interpreter.
4. Add fixture-backed validation for active profiles.
5. Move Source Observation normalization, external reference extraction, selected Option mapping, Reference Record hierarchy, promotion command planning, duplicate-prevention rules, and option queries onto the executable profile.
6. Migrate TCGdex, TCGplayer automation, and Scrydex/Scryfall-style proof profiles.
7. Migrate normal admin editing from raw JSON patching to typed section commands and guided controls.
8. Retire provider-specific mapping code after the generic interpreters cover current behavior.
