# Catalog Resolved Display Identity

## Purpose

Catalog owns product-facing Catalog Item display copy. Display Templates are Catalog authoring policy, while Resolved Display Identity is the Catalog-owned fact produced from that policy for one Catalog Item.

This contract exists so template changes update Catalog admin, public discovery, Google Shopping feed rows, Marketplace seller surfaces, Inventory labels, Pricing recommendations, replay, rebuild, seed reconciliation, and repair workflows through one stable pattern.

## Terms

- `Display Template`: Catalog-owned authoring policy that resolves title and subtitle copy from Catalog facts.
- `Resolved Display Identity`: the resolved item-level fact that downstream contexts may consume.
- `Fallback metadata`: item-specific Catalog metadata title/subtitle stored on the Catalog Item for authoring fallback and exceptional override data.

Downstream contexts must not subscribe to or interpret `catalog.display-template.*` events. Those events are internal Catalog authoring-policy changes. Downstream contexts consume only stable Catalog Item facts.

## Published Fact

Resolved Display Identity contains:

- `catalog_item_id`
- `language_code`
- `title`
- `subtitle`
- `display_template_key`
- `display_template_target_kind`
- `display_template_target_id`
- `display_identity_hash`
- `resolved_at`
- resolver version metadata
- `resolution_status` — `resolved` (a template matched and every non-optional title token rendered non-empty) or `degraded` (no template matched, a targeted template's required field was unsatisfied, or a non-optional title token rendered empty). Added additively to the fact; historical facts without it are treated as `resolved`.
- `missing_tokens` — the required field keys or non-optional title tokens left unsatisfied when degraded (or the `template` sentinel when no template targeted the item); empty when resolved.

A degraded identity still carries a displayable title (the bare native metadata title), so `resolution_status` changes observability, not what renders. The resolution outcome is folded into `display_identity_hash`, so a status transition republishes even when the rendered title and subtitle are unchanged.

The fact never changes:

- `catalog_item_id`
- `product_id`
- selected Options
- Product validity
- Blueprint product resolution rules
- provider external references

## Storage Decision

Use a dedicated Catalog read-model table for resolved display identities, keyed by `catalog_item_id` and `language_code`.

Reasons:

- It keeps fallback metadata on `catalog_items` separate from product-facing resolved copy.
- It allows the resolver to carry hash, template, locale, and resolved-at metadata without overloading the base item row.
- It gives backfill, replay, and repair workflows a direct source-of-truth table.
- It lets downstream publication compare old and new hashes without treating every metadata update as a display identity change.

Resolved identity columns on `catalog_items` are not the preferred model because they blur fallback metadata with resolved product-facing copy and make future locale expansion harder.

## Locale Semantics

The initial implementation resolves the default English display identity and records `language_code = "en"`.

Catalog Item fallback metadata can remain localized. Resolved Display Identity stores the locale it represents and hashes the locale with title, subtitle, template key, and resolver version so additional locales can be added later without changing the contract shape.

If a requested downstream locale does not have a resolved identity, consumers use the English/default resolved identity rather than recomputing from templates.

## Resolver Inputs

The canonical resolver must be shared by live projection, rebuild, backfill, seed reconciliation, admin read models, and tests.

Resolver inputs include:

- active Display Templates and their lifecycle state
- Catalog Item fallback metadata
- Catalog Item Field values
- Field definition keys
- selected Reference Records
- Reference Record names, keys, attributes, relationships, and lifecycle state
- Category assignment and category metadata
- Blueprint assignment and blueprint metadata
- Catalog Item lifecycle/status transitions

If a future input cannot affect display identity, the implementation must document that exclusion beside the trigger set.

## Recompute Triggers

Any resolver input change must enqueue bounded, idempotent recomputation work for the affected Catalog Items.

The trigger set includes:

- Display Template create, revise, publish, deprecate, and archive
- Catalog Item create, metadata revise, field value set/clear, category assign/remove, blueprint assign, publish, retire, and archive
- Field create/configure/activate/deprecate/archive when the field key is used by affected items
- Reference Record create/revise/publish/deprecate/archive, including relationship graph dependents up to the resolver expansion depth
- Category create/revise/publish/deprecate/archive for assigned items
- Blueprint create/revise/publish/deprecate/archive for assigned items
- seed reconciliation when a seeded Display Template definition changes

Recomputation must be resumable. Template-level events must not synchronously refresh all Catalog Item projections inside a projector handler.

## Publication Strategy

Catalog publishes item-level display identity facts when, and only when, the resolved display identity hash changes.

Recommended event:

- `catalog.catalog-item.display-identity-resolved`

The event data must contain the Published Fact fields above. It must carry enough data for every downstream context to update title/subtitle without cross-context reads and without importing Catalog Display Template internals.

Subscriptions that consume this event must bump `subscriptionVersion` and include deploy-skew behavior in the rollout plan. Old consumers should continue processing existing Catalog Item events until their subscription version is upgraded.

## Downstream Consumption

Consumers update only their local projections from the item-level fact:

- Discovery updates search, item detail, search text, sort labels, and slug/canonical behavior.
- Google Shopping feed rows update item title/subtitle from the Catalog-resolved fact.
- Marketplace updates listing, offer, and seller workflow snapshots that display Catalog item labels.
- Inventory updates item list/detail and Catalog item projection labels.
- Pricing updates Catalog input projections and recommendation labels.

Downstream contexts do not resolve templates and do not import Display Template code, types, or read models.

`catalog.catalog-item.created` may bootstrap downstream rows with fallback title/subtitle values so replay can create complete local records before the first resolved identity fact arrives. After row creation, title/subtitle changes must come from `catalog.catalog-item.display-identity-resolved`, not from fallback metadata revisions. Contexts that need non-display metadata from `catalog.catalog-item.metadata-revised` should update only those non-display fields.

## Slug Policy

Discovery owns public slug behavior. When Resolved Display Identity changes the public title/subtitle:

- Discovery may compute a new canonical slug from the resolved display fields plus the stable entity id suffix.
- The previous slug redirects to the current slug for the same `catalog_item_id`.
- The display identity change does not create a new Catalog Item or Product.

Slug behavior must be tested with title/subtitle changes from the display identity event, not only metadata revision events.

## Seed Reconciliation

Seeded Display Templates are durable Catalog authoring data. Bootstrap must reconcile known seeded templates by stable seed IDs or keys instead of skipping all templates when any `catalog_display_templates` row exists.

Seed reconciliation must:

- create missing seeded templates
- revise changed seeded template definitions
- preserve operator-authored templates
- remain idempotent on repeated bootstrap
- route changed definitions through the same recompute and publication path as operator edits

Bootstrap may include a narrow idempotent publish guard when seeded template reconciliation reads stale projection state during the same run. That guard is not a general domain relaxation and must not become a downstream display propagation path.

## Backfill, Repair, And Rebuild

Operators need a safe repair path for stale display copy.

The runbook must identify:

- the active Display Template row or seed definition
- affected Catalog Item count
- recompute job state
- old and new `display_identity_hash`
- emitted item-level fact
- downstream projection lag
- downstream snapshot values for Discovery, Google Shopping, Marketplace, Inventory, and Pricing

Backfill and repair operations must be idempotent and publish only changed identities.

## Observability

Metrics and structured diagnostics must answer:

- whether a template change queued recomputation work
- how many items were considered, changed, skipped, and failed
- whether downstream consumers processed the item-level facts
- whether projection lag or stale snapshot checks remain after repair

Metric labels must be bounded. Do not use item IDs, rendered titles, template names, or other high-cardinality labels.

## Rollout Gates

Broad implementation starts only after this contract is recorded and accepted.

Before production rollout:

- storage migration and rollback path are documented
- subscription versioning and deploy-skew behavior are documented
- downstream repair ownership is assigned for every consumer
- observability is available in staging
- replay/regression tests cover the original stale-template failure mode
- staging verifies a template-driven display identity change, seed reconciliation, backfill/rebuild, and downstream repair diagnosis

## Reusable Derived-Fact Pattern

Use this pattern for future Catalog policy-derived facts:

1. The owning context declares the derived fact and its inputs.
2. The owning context resolves the fact through one canonical resolver.
3. The owning context persists the resolved fact with hash/version metadata.
4. Policy or input changes enqueue bounded recomputation work.
5. Only changed facts are published downstream.
6. Downstream contexts consume stable item/root facts, not internal policy events.
7. Replay, rebuild, backfill, live updates, seeds, tests, and repair use the same resolver.
