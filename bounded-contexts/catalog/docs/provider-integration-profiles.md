# Provider Integration Profiles

Catalog provider integrations own the Catalog structure required to ingest and promote provider facts.

## Purpose

A provider integration profile is Catalog-owned setup for a product line or provider. It can create or reconcile Fields, Dimensions, Options, Components, Blueprints, Categories, Reference Types, and Reference Records needed by the integration. It also carries the provider semantics used after bootstrap: provider key, label, capabilities, supported scopes, option queries, normalized observation mapping, Catalog field mapping, reference hierarchy mapping, external reference extraction rules, reference target level, and ambiguity rules.

Provider integration profiles are not fake data. They are the authoring structure that lets operators import, review, promote, and publish real provider observations.

Executable mapping semantics are documented in [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md). That contract is the migration target for profile versions, selectors, transforms, normalized Source Observation output, hash material, merge identity, external references, selected Options, Reference Record hierarchy, duplicate-prevention rules, and Catalog aggregate promotion command plans. Provider transport adapters should fetch provider payloads only; Catalog-owned profile data decides how those payloads become Catalog review facts.

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

## Future Integrations

Future TCG integrations should add their own provider integration profile when their structure differs from Pokemon TCG. Do not place integration-specific fields or blueprints in deployables, and do not make scenario data the source of structural truth.

Each profile should define:

- provider key and supported lookup/import scopes
- provider label and capabilities
- option query definitions and parent scope requirements
- required Fields and value types
- reusable Reference Types and Reference Records
- Dimensions and Options that affect product identity
- Components and Blueprints used to author and resolve Products
- Categories used for browse grouping
- external reference extraction rules and item-level vs product-level target
- ambiguity rules for repeated or incomplete provider identifiers
- promotion mapping from normalized provider observations into Catalog Item commands

## Boundary

Catalog owns provider integration profiles. Discovery, Inventory, Marketplace, Checkout, Ordering, Pricing, and other downstream contexts consume promoted Catalog facts and resolved Product structure; they do not own provider structure.
