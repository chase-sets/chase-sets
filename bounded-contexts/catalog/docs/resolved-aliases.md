# Catalog Resolved Aliases

## Purpose

Catalog owns alias and translation equivalence truth. Alias Candidates, review state, source governance, auto-accept, and revocation are Catalog-internal authoring policy. `Resolved Aliases` is the stable downstream fact Catalog derives from accepted aliases so Discovery search (#1911) and display (#1914) can match and surface alias text without inspecting alias candidates, provider profiles, or the alias review state machine.

This contract follows the [Catalog Resolved Display Identity](./resolved-display-identity.md) derived-fact pattern. Where Resolved Display Identity publishes item title/subtitle copy, Resolved Aliases publishes the set of accepted alias names for a target.

## Terms

- `Catalog Alias` / `Alias Candidate`: the reviewable, typed, confidence-scored evidence, defined in the [Catalog Alias Vocabulary And Ownership ADR](./catalog-alias-vocabulary-adr.md). Catalog-internal.
- `Resolved Aliases`: the resolved per-target, per-language alias fact downstream contexts consume.
- `Publishable alias`: an accepted or auto-accepted alias. Only publishable aliases enter a resolved fact; pending, rejected, revoked, and generated aliases never do.

Downstream contexts must not subscribe to or interpret `catalog.alias.*` events. Those are internal alias lifecycle changes. Downstream contexts consume only the resolved facts below.

## Published Fact

There are two events, one per target kind, declared on the owning aggregate alongside the other Catalog Item / Reference Record facts:

- `catalog.catalog-item.aliases-resolved` (declared on the Catalog Item aggregate, stream `catalog.item-<id>`).
- `catalog.reference-record.aliases-resolved` (declared on the Reference Record aggregate, stream `catalog.reference-record-<id>`). These carry the ADR's reference-level alias types (`set-equivalent`, `series-equivalent`).

Each fact contains:

- target id (`catalogItemId` / `referenceRecordId`)
- `aliasLanguageCode`
- `aliases`: the resolved alias list, each entry carrying:
  - `aliasHash`
  - `aliasText`
  - `normalizedAliasText`
  - `aliasType`
  - `confidence`
  - `broad` (true when the alias text fans out to multiple Catalog Items, e.g. a species name)
  - `providerKey` and `sourceCategory` (provenance summary)
- `resolvedAliasHash`
- `resolverVersion`
- `resolvedAt`

The fact never changes `catalog_item_id`, `product_id`, selected Options, Product validity, Resolved Display Identity, or provider external references. An alias adds matchable text and "also known as" context; it never renames the item or replaces the primary display label.

## Storage Decision

Catalog persists resolved aliases in dedicated read-model tables, keyed by target id and alias language:

- `catalog_item_resolved_aliases`
- `catalog_reference_record_resolved_aliases`

Each row holds the resolved alias list as JSON plus `resolved_alias_hash`, `resolver_version`, and `resolved_at`. Keeping resolved facts separate from the per-alias `catalog_item_aliases` / `catalog_reference_record_aliases` rows lets publication compare old and new resolved hashes without treating every individual alias review event as a fact change, and gives backfill, replay, and repair a direct source-of-truth table.

## Resolver Inputs

The canonical resolver (`features/alias-equivalence/read-model/resolved-aliases.ts`) is shared by live recompute, backfill, rebuild, replay, and tests. Its inputs:

- the publishable (accepted / auto-accepted) aliases for the target, from `listPublishableCatalogItemAliases` / `listPublishableReferenceRecordAliases` (#1905)
- the publishable cardinality of each alias text, from `countCatalogItemsForAliasText`, used to set the `broad` flag

The resolver reads only publishable aliases, so review state, provider payloads, and candidate rows never leak into the fact.

## Recompute Triggers

Any change to the publishable alias set for a target enqueues bounded, idempotent recompute work for that target. The trigger set:

- an alias is proposed for a target (`catalog.alias.proposed`)
- an alias is accepted, rejected, or revoked (`catalog.alias.accepted` / `.rejected` / `.revoked`)
- promotion / reapply writes or retracts accepted aliases (#1909), which routes through the alias lifecycle events above

Recompute work lives in `catalog_item_alias_recompute_work` and `catalog_reference_record_alias_recompute_work`, one row per target id, drained by a bounded worker. Recompute is resumable and never refreshes all targets synchronously inside a projector handler.

## Publication Strategy

Catalog publishes a resolved alias fact when, and only when, the `resolved_alias_hash` for a (target, language) changes. The worker resolves the publishable set, persists the resolved fact, and emits `aliases-resolved` only on a hash change. Re-running recompute on unchanged evidence publishes nothing.

### Removal

Removal is explicit. When the last publishable alias for a (target, language) is revoked or rejected, the resolver produces a resolved fact with an empty alias list. That empty fact has a different hash than the prior non-empty fact, so publication emits it as a retraction. Downstream search (#1911) and display (#1914) drop the aliases for that target instead of an alias silently disappearing. Catalog never hard-deletes the resolved row; the empty fact is durable and re-publishable on rebuild.

## Subscription Versioning And Deploy Skew

`catalog.catalog-item.aliases-resolved` and `catalog.reference-record.aliases-resolved` are new events. Existing consumers keep working before they subscribe:

- No consumer subscription references the alias facts until its owning slice (Discovery search #1911, display #1914) adds the event types and bumps its `subscriptionVersion`.
- Until then Catalog publishes the facts harmlessly; unsubscribed projections ignore them.
- When a consumer subscribes, it must bump `subscriptionVersion` and follow the deploy-skew rollout: new event types are added to the subscription only after the consumer code that handles them is deployed, so a replay never delivers an unknown event to old consumer code.
- Bootstrapping consumers may create local target rows from `catalog.catalog-item.created` / `catalog.reference-record.created` and then apply alias changes only from the resolved alias facts, never from internal alias lifecycle events.

## Backfill, Repair, And Rebuild

Operators rebuild resolved alias facts for existing promoted TCGdex records without a new alias change:

- `enqueueAllCatalogItemAliasRecomputeWork` enqueues every Catalog Item that already carries a published alias.
- `enqueueAllReferenceRecordAliasRecomputeWork` enqueues every Reference Record that already carries a published alias.

Backfill resolves and publishes only changed facts, so re-running it is idempotent. Health (`getCatalogItemAliasRecomputeHealth` / `getReferenceRecordAliasRecomputeHealth`) and retention purge (`purgeCompletedCatalogItemAliasRecomputeWork` / `purgeCompletedReferenceRecordAliasRecomputeWork`) mirror the Resolved Display Identity recompute operations.

## Observability

Recompute health answers, with bounded labels only (never target ids, alias text, or provider-specific high-cardinality values):

- whether an alias change queued recompute work
- how many targets were considered, changed, skipped, and failed
- oldest pending work and the latest failure message

## Reusable Derived-Fact Pattern

This contract is the second application of the [Resolved Display Identity reusable derived-fact pattern](./resolved-display-identity.md#reusable-derived-fact-pattern): Catalog declares the fact and inputs, resolves it through one canonical resolver, persists it with hash/version metadata, enqueues bounded recompute on input change, publishes only changed facts (including empty/retracted facts for removal), and downstream contexts consume the stable target fact rather than internal policy events.
