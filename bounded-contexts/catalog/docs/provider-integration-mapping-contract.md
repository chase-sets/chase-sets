# Provider Integration Mapping Contract

Catalog provider integrations use an executable mapping contract to turn provider payload evidence into Catalog-owned review data and command plans.

This contract is the target migration path for Provider Integration Profiles. It does not replace provider transport adapters. Transport adapters fetch and parse provider payloads. Catalog-owned mapping profiles define what the payload means to Catalog.

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

Some behavior remains a named reviewed runtime function until a generic interpreter can express it safely. Examples include existing TCGdex variant expansion, marketplace reference extraction, TCGdex Pokemon Reference Record hierarchy provisioning, Pokemon promotion command planning, TCGplayer SKU selected option resolution, and Scrydex/Scryfall-style `tcgplayer_id` extraction.

Profiles may reference those functions by a stable function key. They may not execute arbitrary code or carry dynamic scripts.

The selector and transform interpreter lives at:

`bounded-contexts/catalog/features/source-observations/api/provider-mapping-interpreter.ts`

The interpreter evaluates provider payload evidence only. It returns evidence values with owner, use, and redaction metadata; it does not automatically make output Catalog truth. It supports nested paths, constants, coalescing, object selectors, array mapping, string transforms, coercion, lookup tables, and explicitly registered named selectors/transforms. Missing required fields, unregistered named functions, lookup misses, empty arrays, and type coercion failures return diagnostics that identify the config path and redaction category without including raw provider values.

Profile activation and import preparation should validate executable expressions against fixture payloads before import jobs run. Invalid configs fail at validation time, not halfway through a live provider import.

## Lifecycle

- `draft`: authored but not eligible for import jobs.
- `test`: fixture-backed and usable in validation, dry runs, and explicit non-production jobs.
- `active`: the default profile version for new import jobs.
- `deprecated`: retained for replay or rollback, but not selected for new imports.
- `retired`: retained only for historical Source Observation compatibility.

Activating a profile version must validate the schema, fixture coverage, unsafe evidence use, required mappings, and redaction policy before import jobs run.

## Replay Compatibility

Source Observations should record the profile version that produced their normalized data and hash material. Replaying or reapplying a Source Observation must be deterministic:

- default replay uses the same profile version that produced the observation
- operator-initiated reapply may use the currently active profile version
- deprecated and retired profile versions remain readable until all observations that reference them are migrated or archived
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
7. Retire provider-specific mapping code after the generic interpreters cover current behavior.
