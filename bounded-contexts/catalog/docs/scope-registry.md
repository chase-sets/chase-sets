# Catalog Scope Registry

The Catalog Scope Registry is the canonical Catalog-owned list of product-line, series, expansion, and set records that can define sync identity. It is a read model over Catalog Reference Records, so a scope record can exist before any provider exposes a matching product line, set id, set name, or category id.

## Scope Record Contract

Catalog Scope Records use these Reference Record type keys:

| Product domain | Product line | Series | Expansion or set |
| --- | --- | --- | --- |
| `pokemon` | `product-line` | `series` | `expansion` |
| `magic` | `product-line` | `series` | `set` |
| `yugioh` | `product-line` | `series` | `set` |
| `one-piece` | `product-line` | `series` | `set` |
| `lorcana` | `product-line` | `series` | `set` |

The canonical product-line Reference Record keys are `pokemon-trading-card-game`, `magic-the-gathering`, `yu-gi-oh-official-card-game`, `one-piece-card-game`, and `disney-lorcana`.

Expansion and set scope records use Reference Record attributes for:

- `release-date`: official first release date for the scope record when known.
- `official-set-code`: product-domain official code, such as `PAF`, `TSP`, `LOB`, `OP-01`, or `1`.
- `language-editions`: language codes for known official editions.

Legacy provider attributes such as `set-code` or `abbreviation` may remain as provider evidence, but the registry contract names `official-set-code` as the canonical scope attribute.

## Read Model

`catalog_scope_records` projects `catalog.reference-record.*` lifecycle events into one row per canonical scope Reference Record. Rows keep:

- product domain and scope kind
- Reference Record id, key, localized name, attributes, and relationships
- parent scope, product-line scope, and series scope ids
- release date, official set code, and language editions
- lifecycle status: `draft`, `active`, `deprecated`, or `archived`

The projection does not rewrite Source Observation sync planning. Provider-specific ids, names, and category mappings remain provider evidence until the Provider Scope Mapping slice maps them onto these canonical Scope Records through review.

## Boundaries

Catalog Scope Record is canonical Catalog identity. Provider Scope Mapping is the reviewed provider-to-canonical bridge keyed by `scope_record_id`, `provider_key`, and `unit_key`. Scope Coverage is the future read model that will show which providers can cover each canonical Scope Record. Scope Sync is the future workflow that starts from a Scope Record, applies approved provider mappings, and then delegates provider pulls.

## Destructive Reset And Merge Candidate v2 (#3807)

`CatalogSyncScope` v2 (#3794) and the Catalog Merge Candidate identity re-key (#3799) both require pre-launch destructive reset/rebuild of Catalog Merge Candidate review state. `bounded-contexts/catalog/features/source-observations/api/catalog-scope-merge-candidate-reset.ts` is the P0 plan and machinery both slices must reference before any destructive execution:

- **Reset targets** (`catalogScopeMergeCandidateResetSurfacePolicies`): `catalog_merge_candidates`, `catalog_merge_candidate_observations`, unreviewed `catalog_provider_scope_mappings` rows (`review_status = 'proposed'`), and the `catalog.merge-candidate-*` event streams (`event_store_streams` / `event_store_events`). Old Merge Candidate streams encode the pre-reset candidate identity and are wiped rather than replayed forward.
- **Preserved surfaces** (`catalogScopeMergeCandidatePreservedSurfaces`): `catalog_scope_records` in full, every reviewed `catalog_provider_scope_mappings` row (`accepted`, `auto-accepted`, `rejected`, `revoked`), `catalog_source_observations` in full, and promoted Catalog Items/aliases/external references. `resetCatalogMergeCandidateDerivedState` asserts these row counts are unchanged after every reset run and throws instead of committing an unsafe reset.
- **Catalog sync parent-run cleanup** composes with the existing pre-launch reset in `catalog-integration-data-migration-reset.ts` (`catalog_source_observation_integration_durable_jobs` and related job/work-unit tables); this plan does not duplicate it.
- **Rebuild** is deterministic: `generateCatalogMergeCandidates` (`POST /merge-candidates/generate` with no scope filter) re-derives every candidate from preserved Source Observations through the active matcher. See `catalogScopeMergeCandidateRebuildChecklist()` for the full wipe-then-rebuild sequence and `evaluateCatalogScopeMergeCandidateResetEvidence()` for the same staging/production approval, backup, dry-run, before/after, and rebuild-verification gates as the Source Observation reset.

Merge Candidate v2 persists canonical identity as `{scopeRecordId, collectorNumber, languageCode, productForm, variantKey, barcode}`. Provider product-line and set names remain proposed Catalog facts and provenance; they no longer participate in identity. Before matching, each Source Observation resolves its provider coordinates through an `accepted` or `auto-accepted` Provider Scope Mapping. The generate response reports `unmapped-provider-scope` and `ambiguous-provider-scope` exclusions with observation ids and visible reasons, so unresolved observations stay out of candidate streams without disappearing from operational evidence.

Migration `20260713_catalog_merge_candidate_scope_identity_v2` covers existing databases. Under the schema-bootstrap lock and a five-second `lock_timeout`, it deletes only Merge Candidate membership rows, candidate rows, and `catalog.merge-candidate-*` streams, then requires and indexes `scope_record_id`. The fresh `CREATE TABLE` path creates the same required foreign key directly. Source Observations, every Provider Scope Mapping review status, Scope Records, promoted Catalog Items, aliases, profiles, and credentials are not delete targets of this identity migration. After bootstrap, operators run the unfiltered generate command and retain its matched/excluded counts as rebuild evidence. Re-running generation is idempotent because canonical identity produces stable candidate ids and refreshes the same streams rather than creating duplicates.
