# Catalog Display Identity Propagation Runbook

Catalog owns resolved Catalog Item display identity. Display Templates are authoring policy; downstream contexts consume the item-level `catalog.catalog-item.display-identity-resolved` fact and must not consume `catalog.display-template.*` events.

## Source Of Truth

Use Catalog as the source of truth:

- `catalog_display_templates` stores authoring templates.
- `catalog_item_display_identities` stores the resolved item-level fact by `catalog_item_id` and `language_code`.
- `catalog_item_display_identity_recompute_work` stores pending bounded recomputation work.
- Catalog Item streams publish `catalog.catalog-item.display-identity-resolved` when the persisted display identity hash changes.

Resolved display identity never changes `catalog_item_id`, `product_id`, selected Options, product-resolution validity, or provider references.

## Health Checks

Catalog runtime exposes display identity recomputation health through `getDisplayIdentityRecomputeHealth()`:

- `pending`: work waiting for a worker.
- `running`: work currently claimed.
- `completed`: work completed.
- `pendingWithError`: pending work retrying after failure.
- `oldestPendingAt`: first pending work timestamp.
- `latestFailureMessage`: most recent retry failure.

Expected operator thresholds:

- Investigate if pending work grows for more than one deploy window.
- Investigate immediately if `pendingWithError` is non-zero after retry.
- Stop rollout if changed identities publish but downstream projection lag does not recover.

Metric/log labels must stay bounded. Do not label by item ID, template key, rendered title, or raw template text.

## Backfill Or Repair

1. Confirm the Display Template row has the expected status, target, priority, title template, subtitle template, and required field keys.
2. Confirm the affected Catalog Item has the expected blueprint, categories, field values, and reference records.
3. Enqueue all affected items, or all Catalog Items for a broad repair, with reason `manual-backfill` or `repair`.
4. Run `processDisplayIdentityRecomputeBatch()` until `selected` is zero.
5. Confirm `catalog_item_display_identities` has the expected title, subtitle, template key, hash, resolver version, and resolved timestamp.
6. Confirm a `catalog.catalog-item.display-identity-resolved` fact exists only when the hash changed.
7. Confirm downstream projections have consumed the fact.

Downstream repair checks:

- Discovery: verify search source row, derived search item, item detail row, slug redirect/canonical behavior.
- Google Shopping: verify feed row source title/subtitle and feed export freshness.
- Marketplace: verify catalog item projection, listing/offer labels, and publication snapshots.
- Inventory: verify catalog item projection and inventory item labels.
- Pricing: verify catalog input projection and recommendation labels.

If downstream rows remain stale, repair downstream projections in this order: Discovery search/detail, Google Shopping feed rows, Marketplace, Inventory, Pricing. Use each context projection rebuild/repair operation when available, then re-check against Catalog's `catalog_item_display_identities` row.

## Rollout Verification

Before staging:

- #864 start-gate decisions are recorded in the implementation PR.
- #872 repair workflow is available.
- #873 recompute health is available.
- #874 regression/replay coverage or approved manual verification is recorded.

Staging must verify:

- Template-driven display identity change.
- Seed Display Template reconciliation.
- Backfill/rebuild processing.
- Downstream stale-data diagnosis and repair.
- No unexpected `catalog_item_id` or `product_id` changes.
- No stale title/subtitle snapshots in sampled downstream records.

Production rollout stops if:

- Recompute work repeatedly fails.
- Display identity hashes change unexpectedly for unrelated items.
- Downstream lag does not recover.
- Slug/canonical URL behavior differs from the documented policy.
