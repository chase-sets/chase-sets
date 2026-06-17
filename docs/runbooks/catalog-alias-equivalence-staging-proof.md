# Catalog Alias Equivalence Staging Proof And Operations Runbook

Use this runbook to prove, in staging, that a Japanese TCGdex scope can be
imported, reviewed as alias candidates, promoted, published, found by English
search, and read with an English-locale display name — and to roll the change
back. A fresh operator should be able to follow it end to end through the Admin
UI without editing URLs by hand.

This is the operator-facing companion to the automated milestone proof
(`bounded-contexts/catalog/features/source-observations/api/catalog-integration-alias-equivalence-e2e-proof.ts`)
and the DB-backed acceptance flow
(`bounded-contexts/catalog/tests/catalog-authoring/acceptance/alias-persistence.test.ts`,
the `#1913` full-milestone-flow test). Catalog owns alias facts; Discovery
consumes the published resolved-alias fact. Never re-derive aliases in Discovery.

## Source Of Truth

- `catalog_source_observation_alias_candidates` — alias candidates produced by
  intake, keyed by `alias_hash`, with review status.
- `catalog_item_aliases` / `catalog_reference_record_aliases` — durable accepted
  alias facts; revocation flips `review_status` in place, never hard-deletes.
- `catalog_item_resolved_aliases` / `catalog_reference_record_resolved_aliases` —
  the published resolved fact per `(target, alias language)`. This is exactly the
  row Discovery search folds into `search_text` and the English display reads.
- `catalog_item_alias_recompute_work` / `catalog_reference_record_alias_recompute_work`
  — bounded recompute queue. Accept/reject/revoke enqueue work for the target.
- Catalog Item / Reference Record streams publish
  `catalog.catalog-item.aliases-resolved` / `catalog.reference-record.aliases-resolved`
  only when the resolved hash changes (including the empty/retraction fact).
- Discovery: `discovery_search_catalog_items.resolved_aliases` (source) and
  `discovery_search_items.search_text` (derived tsvector) carry the alias text.

The TCGdex `id` language code is Indonesian, never English. Intake never emits an
English alias from `id` text. Confirm any English equivalent is sourced from the
explicit `/en/` mirror, not from `id`.

## Staging Proof Walkthrough (UI Only)

Use a non-production account with `catalog.manage`. Do every step in the Admin
Control Plane at `/catalog/integrations`; do not hand-edit URLs.

### 1. Choose provider, unit, and Japanese scope

1. Open `/catalog/integrations`.
2. Select provider `TCGdex`, the single-card ingestion unit, then the Japanese
   `Source language`, the `Series`, and the `Expansion`.
3. Expected: the selected language, series, and expansion are each present in the
   option lists (no blank scope). Source option freshness shows recently loaded.

### 2. Pull provider data and monitor the import

1. Start the provider import for the selected scope.
2. Watch the import job move queued -> running -> completed.
3. Expected counts: jobs queued = 1, completed = 1; Source Observations created =
   one per card in the scope. Diagnostic errors = 0. A timeout surfaces as a
   degraded transport blocker, never a raw provider error.

### 3. Review Source Observations

1. Open the Source Observation review for the completed import.
2. Confirm provenance (provider key, unit key, source profile version), native
   names, and redaction summaries are present; no raw provider body is shown.

### 4. Review alias candidates (alias-review workspace)

1. Open the alias-review workspace for the scope.
2. For each candidate confirm: native printed name, proposed alias, alias type,
   confidence, source category, evidence lines, and review status.
3. Expected mix for a Japanese Pokemon scope (see the automated proof for exact
   counts):
   - a Pokemon (e.g. native サボネア) carries a same-id English
     `official-equivalent` candidate (held for review) AND a `species-name`
     candidate (English `Cacnea`) — the species alias is what lets English search
     find the Japanese card.
   - a Trainer/Energy card has NO `species-name` candidate; `dexId` cannot give a
     species equivalent. It may still carry a same-id English official equivalent
     if the `/en/` mirror matched.
   - an expansion/series shows native `set-equivalent`/`series-equivalent`
     candidates, plus English ones when the `/en/` mirror exists. If the mirror is
     missing they stay pending — a documented pending state, not a guess.
   - a card whose `/en/` mirror is missing produces no English official
     equivalent at all. Absence of an English equivalent is valid; do not backfill.
4. Generated/low-confidence candidates are clearly marked and never masquerade as
   official truth. Pending candidates are visibly pending.
5. Accept the reviewed official equivalents and species aliases that are correct.
   Reject incorrect candidates. Leave anything you cannot verify as pending.
   Auto-accept is only offered when governance permits it for that source.

### 5. Promote and publish

1. Promote the reviewed scope.
2. Expected: accepted/auto-accepted candidates become publishable Catalog Item
   and Reference Record alias facts; pending/rejected candidates do not publish.
3. The resolved-alias recompute then publishes one `aliases-resolved` fact per
   changed target. Confirm the readiness/health view shows recompute pending
   draining to zero and no `pendingWithError`.

### 6. Prove the buyer outcome — English search (#1911)

1. In the marketplace search, query the English name (e.g. `Cacnea`).
2. Expected: both the English card and the promoted Japanese card appear. Before
   acceptance, the English query reaches only the English card.
3. Query the native name (e.g. `サボネア`) and a native substring (e.g. `サボネ`).
   Expected: the Japanese card still matches both (CJK bigram tokenization).
4. An exact English title outranks a broad species-alias match; a generated
   low-confidence alias never outranks an official English title.

### 7. Prove the buyer outcome — English display (#1914)

1. Open the Japanese card in an English locale.
2. Expected: the primary display name is the accepted English name with the native
   name as secondary, e.g. `Cacnea (サボネア)`. A `species-name`, `romanization`,
   `generated-translation`, or pending/rejected alias never becomes the primary
   display name.

### 8. Prove revocation removes the alias (search + display)

1. In the alias-review workspace, revoke a previously accepted English alias.
2. Expected: recompute publishes the empty (retracted) resolved fact for that
   `(item, language)`. The English query no longer returns the Japanese card, and
   the English-locale display reverts to the native name (e.g. `サボネア`). The
   card itself, its native search, and its other aliases are unaffected.

## Expected Counts Reference

The automated milestone proof records the canonical stage counts for a fixed
five-card Japanese fixture. Run it to see the exact expected values:

```
pnpm --filter @chase-sets/catalog exec vitest run \
  features/source-observations/api/catalog-integration-alias-equivalence-e2e-proof.test.ts \
  --config ./tests/vitest.config.mjs
```

Stage outline (fixture-specific values in the proof packet):

| Stage             | What to expect                                                            |
| ----------------- | ------------------------------------------------------------------------- |
| Source options    | language, series, expansion each selected and present                     |
| Import            | queued = completed = observations = number of cards in scope              |
| Candidates        | native localized + set/series-equivalent per card; English + species when the `/en/` mirror matches; no species alias for Trainer/Energy |
| Review            | accepted / auto-accepted / pending / rejected; pending official equivalents block high-confidence English search |
| Promotion         | accepted candidates publishable; pending/rejected proposed evidence-only  |
| Publish           | one resolved fact per changed target; empty fact on full retraction       |
| Search (#1911)    | accepted English aliases make the Japanese card English-reachable         |
| Display (#1914)   | accepted English name as primary, native name as secondary                |

## Health Checks

Catalog runtime exposes resolved-alias recompute health through
`getCatalogItemAliasRecomputeHealth()` and `getReferenceRecordAliasRecomputeHealth()`:
`pending`, `running`, `completed`, `pendingWithError`, `oldestPendingAt`,
`latestFailureMessage`.

Operator thresholds:

- Investigate if `pending` grows past one deploy window (projection lag —
  diagnostic `alias-resolved-projection-lag`).
- Investigate immediately if `pendingWithError` is non-zero after retry.
- If a published resolved hash no longer matches the publishable aliases
  (diagnostic `alias-stale-resolved-hash`), run alias backfill below.
- If English search shows no alias recall at all, check whether the rollout
  kill-switch is closed (diagnostic `alias-search-rollout-disabled`).

Keep metric/log labels bounded: provider key, alias type, alias language,
diagnostic code. Never label by item id, raw alias text, or provider body.

## Rollback And Rebuild

### Disable alias contribution to search (fastest mitigation)

A bad resolved-alias batch is disabled without a code deploy by setting the
Discovery rollout kill-switch and rebuilding the search index:

1. Set `DISCOVERY_ALIAS_SEARCH` to a disabling value (`disabled`, `off`, `false`,
   `0`, or `kill`) for the Discovery deployable. The control defaults to OPEN, so
   this is the only switch needed to drop alias text from every item's search.
2. Rebuild the Discovery search index (`rebuildDiscoverySearchIndex`). Alias text
   is dropped from `search_text` on rebuild; the source `resolved_aliases` rows
   are retained, so re-enabling and rebuilding restores recall.
3. Re-enable by removing the env value and rebuilding the index again.

### Revoke specific aliases (targeted)

Revoke the offending alias in the alias-review workspace. Revocation publishes the
empty/retracted resolved fact, which removes the alias from search and reverts
display. Revocation is idempotent and retains provenance for audit.

### Alias backfill (rebuild published facts)

Rebuild the resolved alias facts for every target that already carries published
aliases (after a resolver change, deploy skew, or a stale resolved hash):

1. Enqueue: `enqueueAllCatalogItemAliasRecomputeWork()` and
   `enqueueAllReferenceRecordAliasRecomputeWork()` (reason `manual-backfill`).
2. Drain: `processCatalogItemAliasRecomputeBatch()` and
   `processReferenceRecordAliasRecomputeBatch()` until `selected` is zero.
3. Confirm `catalog_item_resolved_aliases` / `catalog_reference_record_resolved_aliases`
   carry the expected aliases, hash, and resolver version, and that
   `aliases-resolved` facts were published only where the hash changed.
4. Purge completed recompute work past the retention cutoff after verification.

### Discovery reindex (rebuild search projection)

After an alias backfill or kill-switch change, rebuild the Discovery search index
so `search_text` reflects the current published facts. The rebuild is idempotent
and applies negative projection: a retracted alias stays gone after rebuild.

### Display recompute (rebuild English display)

Accepted/revoked aliases enqueue Catalog Item display-identity recompute through
the `aliases-resolved` fact. To force a rebuild, enqueue display-identity recompute
for the affected items (reason `repair`) and run
`processDisplayIdentityRecomputeBatch()` until `selected` is zero, then confirm
`catalog_item_display_identities` shows the expected English title (English name
with native secondary, or native name after a revoke).

## Diagnostics

The integration diagnostic taxonomy
(`bounded-contexts/catalog/features/source-observations/api/catalog-integration-diagnostic-taxonomy.ts`)
names the alias failure modes operators triage:

- `alias-provider-endpoint-missing` — the `/en/` mirror did not exist for an id;
  keep the native alias and review for an English equivalent later.
- `alias-coverage-incomplete` — some cards still lack an accepted English alias.
- `alias-pending-candidates-block-high-confidence-search` — accept pending
  candidates so English search reaches the card at high-confidence weight.
- `alias-resolved-projection-lag` — recompute or the Discovery alias projection is
  behind; wait for catch-up or drain recompute.
- `alias-stale-resolved-hash` — the published resolved hash no longer matches the
  publishable aliases; run alias backfill.
- `alias-search-rollout-disabled` — the `DISCOVERY_ALIAS_SEARCH` kill-switch is
  closed; re-enable and rebuild the search index.
- `alias-native-script-tokenization-gap` — a native CJK alias produced no search
  bigrams; check the alias text and Discovery normalization.
