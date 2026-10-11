# Catalog Scope Sync And Merge Candidate Handoff

This handoff is the operator and maintainer guide for milestone #54: a scope-first, multi-provider Catalog sync that reviews merged Catalog candidates before canonical Catalog Item/Product changes are promoted.

The workflow is:

```text
Choose Catalog scope and providers
-> pull provider Source Observations
-> build merged Catalog candidates
-> resolve promote, split, update, ignore, or defer decisions
-> preview Promotable Catalog Item/Product Changes
-> apply canonical Catalog commands after approval
```

## Ownership

- Catalog owns semantic scope contracts, provider eligibility, Source Observations, merge candidates, candidate review decisions, promotion planning, canonical Catalog commands, rollout-control enforcement, and admin read models.
- Provider adapters own provider transport only. They do not own merge identity, selected Options, duplicate prevention, Product mapping, or canonical promotion decisions.
- Deployables compose Catalog routes and UI modules. They must not duplicate promotion planner logic, parse provider payloads, or require admins to author raw JSON for normal review.
- Operators use the Admin workbench and visible rollout controls. Normal UAT must not depend on handcrafted URLs, direct API calls, SQL, CLI commands, provider endpoints, or browser-console state changes.

## First Shippable Vertical Slice

The first shippable slice is Pokemon TCG / English / Expansion with:

- TCGdex item facts as Source Observations.
- TCGplayer marketplace Product and SKU evidence as Source Observations.
- One Catalog scope selected first, then eligible providers selected inside that scope.
- A parent scope sync run with child provider jobs.
- Merge candidates as the primary review unit.
- Promotion planning from approved candidates, not directly from raw provider rows.
- Projection-lag messaging when jobs complete before admin read models catch up.

The slice is not complete until the scope-first workbench, typed split/update command payloads, and #2602 UAT/docs evidence have landed. Do not close epic #2592 or milestone #54 from planner evidence alone.

## Required UAT Scenarios

Use fixture-backed or staging-safe evidence; live provider calls are not required for automated tests.

| Scenario | Acceptance evidence |
| --- | --- |
| Candidate ready path | TCGdex and TCGplayer observations merge into one ready candidate, and the promotion preview creates or refreshes one Catalog Item with the correct External Catalog Item Reference and External Product Reference levels. |
| Candidate conflict path | Disagreeing provider facts keep the candidate blocked, show field provenance and conflict diagnostics, and do not emit canonical Catalog commands. |
| Split path | An incorrectly merged candidate can be split into separate typed command payloads without raw JSON authoring, preserving source membership and audit reason. |
| Update path | An admin can correct identity, variant, selected Option, or reference mapping through typed payloads before promotion, and the preview shows the exact route body. |
| Ignore path | A candidate can be ignored without deleting provider Source Observation evidence or canonical Catalog facts. |
| Defer path | A candidate can be kept in review with an operator reason and no hidden skip list. |
| Re-sync path | Changed provider facts update Source Observations and mark the candidate or promotable change stale, changed, or blocked until reviewed. |
| Partial provider failure | One provider can fail while another succeeds; the parent sync run remains understandable, retryable, and scoped to the affected child job. |

## Operator Workflow

1. Open Catalog Integrations and select the Catalog scope before selecting providers.
2. Review eligible provider rows, readiness, option freshness, rollout-control state, and estimated work.
3. Start the parent scope sync and follow parent and child job cards to terminal state.
4. Review merge candidates first. Use Source Observations as supporting evidence, not the main decision queue.
5. For each candidate, inspect identity, source membership, field provenance, proposed references, proposed Product mapping, conflicts, and promotion readiness.
6. Choose promote, split, update, ignore, or defer. Split and update must use generated typed command payloads.
7. Preview Promotable Catalog Item/Product Changes before applying canonical commands.
8. Treat stale counts after completed jobs as projection lag unless health diagnostics point to a failed projector or blocked worker.

## Rollout And Emergency Stops

The existing Catalog integration rollout controls are the release and incident boundary for this workflow:

- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=read-only` freezes writes while keeping review available.
- `CATALOG_INTEGRATION_CONTROL_PLANE_MODE=dry-run-only` blocks import, promotion, reapply, and activation while preserving reads and dry-run evidence.
- `CATALOG_INTEGRATION_IMPORTS_DISABLED` or `CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED` stops unsafe provider pulls.
- `CATALOG_INTEGRATION_PROMOTION_DISABLED` or `CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED` stops canonical promotion while allowing evidence review.
- `CATALOG_INTEGRATION_REAPPLY_DISABLED` or `CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED` stops replay/reapply while import review remains governed separately.
- `CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP` or unit-scoped emergency stops isolate provider transport incidents.
- `CATALOG_INTEGRATION_WORKER_MODE=disabled` stops worker processing while queued jobs remain inspectable.

Use the narrowest provider or unit scope that stops the unsafe behavior. Rollback evidence must include the active env value, affected provider/unit, Admin readiness rollout snapshot, denied-control metric key, job counts, and release/deploy identifier.

### Duplicate-Prevention Field Rules Begin Matching

Before #9277, every configured field rule in `bounded-contexts/catalog/features/source-observations/api/promotion/provider-duplicate-prevention-resolver.ts` compared a bare JSON object against the projected `catalog_items.field_values` array, so it never matched and promotion created a new Catalog Item instead of reusing the owner. The source-observation link lookup also compared raw keys against the trimmed, lowercased keys Catalog Items record. Once #9277 deploys, configured field rules match on staging; rule order, rules and ambiguity policy are unchanged, and the exact-reference and source-observation link rules still decide first.

- TCGdex Pokemon: `pokemon-card-partial-draft-retry` reuses a TCGdex draft left without reference links when number, name, variant and the provider, expansion and variant tags agree. `pokemon-card-deterministic-fields` looks the expansion up by name key, while TCGdex keys expansion records by expansion id, so it matches only items whose expansion field references a name-keyed record, never a TCGdex-only promotion.
- Scryfall and Scrydex Magic card prints: `magic-card-print-deterministic-fields` reuses the item with the same set, collector number and English name; both providers key set records by set name.
- TCGplayer Magic sealed products: `sealed-product-deterministic-fields` reuses the item with the same set, name and pack count when no SKU reference claims the observation.
- Scrydex One Piece card prints: the rule looks the set up by name key, while Scrydex keys set records by expansion id, so it matches only items whose set field references a name-keyed set record (the TCGplayer set-record shape), never a Scrydex-only promotion.
- Scrydex One Piece sealed products now map to the seeded `sealed-product-number`, following Scrydex Lorcana and TCGplayer One Piece/Lorcana sealed profiles. The real-loader DB row exercises `one-piece-sealed-product-deterministic-fields` with a name-keyed set, isolated from earlier rules: the same set, name and form match; a differing rule field or absent set does not. This does not change Scrydex's provider-id-keyed hierarchy; ordinary same-provider repeats can converge through exact-reference or source-observation-link rules instead.
- MTGJSON carries the Magic rule but has no Catalog Item promotion capability, so no promotion outcome changes.
- Source-observation links recorded through Catalog Items with mixed case or padding, such as a region-tagged language prefix, now resolve to their owner.

When a field rule matches more than one Catalog Item, the profile's `ambiguousCandidatePolicy` decides: every field-rule profile above uses `block-promotion`, so promotion refuses with the rule's ambiguity diagnostic, the promotion preview reports a blocking `ambiguous-duplicate-candidates` diagnostic, and the integration engine's duplicate-prevention preview shows the row blocked; a `review-only` profile would return the candidates for review instead. A match proves a reuse candidate, not a complete item. If reuse misbehaves, stop it with `CATALOG_INTEGRATION_PROMOTION_DISABLED` or the unit-scoped control.

## Promotion Reference Access Paths

Schema installed by the ledgered migration
`20261010_catalog_promotion_reference_access_paths_v1` (composed through
`catalogAuthoringSchemaMigrations`). Source Observation target exclusion consumes
these paths; ordinary boot installs them before promotion writers activate.

- Functions `catalog_promotion_reference_text_v1(text)` and
  `catalog_promotion_reference_pairs_v1(jsonb)` are immutable, strict and
  parallel safe, pin Unicode 17.0 casing data inside their bodies, and run with
  `search_path = pg_catalog, public`. They are installed only when absent and
  never replaced in place; a same-named function with any other body refuses
  the migration. A casing-data upgrade is a new version plus new indexes.
- Indexes over `event_store_events`, each a non-unique partial index built
  `CONCURRENTLY` outside a transaction:
  - `catalog_promotion_item_reference_v1_idx` and
    `catalog_promotion_product_reference_v1_idx`:
    `(C(providerKey) COLLATE "C", C(externalKey) COLLATE "C", stream_id, stream_version)`
    over `catalog.item-%` streams for the matching
    `external-catalog-item-reference-linked/-unlinked` or
    `external-product-reference-linked/-unlinked` events.
  - `catalog_promotion_source_reference_pairs_v1_idx`: GIN `jsonb_path_ops` over
    `catalog_promotion_reference_pairs_v1(payload->'normalized')` for
    `source-observation.recorded/changed/refreshed` headers, inline or chunked.
  - `catalog_promotion_source_link_v1_idx`:
    `(C(providerKey) COLLATE "C", C(languageCode || ':' || btrim(externalKey)) COLLATE "C", stream_id, stream_version)`
    over the same source headers.
- Boot behavior: functions install before indexes; an interrupted concurrent
  build leaves an invalid owned index that the next boot drops and rebuilds; a
  valid index under one of these names with a different definition refuses the
  migration (`catalog-promotion-reference-index-conflict:<name>`) rather than
  being dropped; retained event bytes are never rewritten.
- Readiness: `readPromotionReferenceAccessPathReadiness` reports installed,
  `indisvalid`, `indisready`, definition-identical, function body and settings
  identical, version marker and casing-data hash, `UTF8` encoding plus
  versionless `"C"` collation, and runtime Unicode parity. Drift is reported as
  not-ready; the function never throws.
- Shared `event_store_events` indexes in `event-store-indexes.ts` are unchanged.

## Promotion Target Exclusion Port

Catalog's `createPostgresPromotionTargetExclusion` composes the shared port for
Source Observation promote/reapply and scope candidate application. Callers
supply explicit member/reference keys, candidate target ids, target selection,
and their policy-appropriate canonical profile validation. Candidate application
still owns its eligibility, degraded-display and authority preflight; acquiring
a binding never certifies application completion.

Discovery follows complete retained source and item histories to a fixed point,
using canonical level/provider/key pairs and keyset pages of at most 500. It
includes historical revisions, deterministic member targets, markers, bindings,
and link/unlink evidence. It does not derive member ids from reference text.
Unknown histories, exceeded budgets and ambiguous owners visibly refuse rather
than authoring another item. Reachable old-format bindings are retained and
guarded, not rewritten; there is no global historical-binding scan.

Each binding or item-command append owns one READ COMMITTED transaction. It
takes the canonical profile relation's SHARE lock, validates profile identity,
selection and retained inputs on that same client, and calls
`appendToStreamsInTransaction` with sorted expected-version guards. Errors roll
back the entire append, including notifications. Disjoint promotions may hold
SHARE concurrently. Acquisition retries version conflicts at most twice, then
returns `promotion-target-rediscovery-exhausted`; stale session writes refuse.

The material authority set is closed:

1. Every discovered Source Observation stream.
2. Every candidate/target Catalog Item stream, including empty deterministic targets.
3. Binding streams for the complete key closure.
4. Reference-authority streams read by reference hierarchy resolution for the plan.
5. Negative unlink/inactive evidence, retained in the guarded item histories.
6. Canonical SQL profile authority under the SHARE lock, not an invented event stream.

No display-template, alias or owner selection-generation stream belongs to this
set. Existing pre-append display validation remains a content gate. Optional
blueprint/category/field guards are not used. Resume must prove a same-target
exact command prefix and current authority; keys bound elsewhere refuse without
retargeting. A complete compatible draft or active target can be reused while
projections lag, without reauthoring its existing prefix.

### Writer Cutover And Rollback

The host disables promotion and drains **all** old promotion and candidate
workers before deploying/enabling the guarded writers. This is an operator
cutover, not a distributed worker census implemented by the port. Do not run
mixed guarded and unguarded writers. Explicit incompatible protocol requests
return `promotion-target-writer-protocol-incompatible`; a store without C's
method returns `promotion-target-transaction-append-unavailable`.

Every acquisition checks B's full access-path readiness; absent, invalid or
drifted infrastructure returns `promotion-target-access-paths-unavailable` with
the failed checks. It never falls back to projected absence or a global scan.
If cutover fails, leave promotion disabled. Rollback stops writers first and
retains the additive schema, bindings and readers, or rolls forward. Restoring
the unguarded allocator against retained guarded writes is not a safe rollback.

## Candidate Application Checkpoints

Single-candidate promote stays approval-only. Scope promotion jobs
(`merge-candidate-promote`, `promotionApplicationVersion: 1`) apply approved
candidates through two candidate-owned checkpoints around the existing candidate
planner and the shared executor:

1. Preflight from the approved snapshot, never the latest observations: fold
   each member's Source Observation stream and use the exact reviewed revision;
   resolve each promotable member's active promotion profile, enforce the
   global/provider/unit promotion rollout controls, require every member to agree
   on blueprint, category, fields and hierarchy Reference Record, and nominate
   reuse targets from the duplicate resolver. Reference provisioning and image
   storage are idempotent preparation and may precede a block; a block appends no
   approval and writes no Catalog Item (`promotion-plan-blocked:<code>`). A ready
   candidate stays ready; an approved one stays approved-but-unapplied and the
   unit fails.
2. Acquire the target through the exclusion port. A retained member target counts
   only with its member's recorded completion, a reference owner or bound target
   is reused (a create intent becomes `refresh`), and a partial, ambiguous or
   unknown target refuses rather than counting as no match. Only when no owner
   exists is `cat_candidate_<sha256(candidateId)>` allocated.
3. Approve at the checked version (ready candidates), then append
   `catalog.merge-candidate.promotion-planned` at the checked version before any
   item command. It binds the approval version, initiating job/unit, target,
   actual mode, target baseline version/state, pinned profile versions, mapping,
   Reference Record and asset inputs, exact commands and fingerprint. One plan
   binds per approval.
4. Execute through the session, which folds the complete target stream and runs
   only the commands its exact suffix has not committed, in every mode. Draft
   targets count as existing; read models never authorize replay writes.
5. Prove the complete event sequence from the target stream, then append
   `catalog.merge-candidate.promotion-applied` once, attributed to the plan's
   initiator.

Recovery: a unit that finds its own application returns the same promoted
result without writes; any later job skips applied candidates (0 promoted, 0
created). A retained plan resumes exactly: the pinned profile stays eligible when
a newer version was merely activated, but revocation, missing reference evidence,
a changed baseline or unrelated target history refuses
(`promotion-application-*`) and keeps the checkpoint for explicit recovery. A
later job may finish another unit's unfinished plan under the same fences.

Results: version-1 unit results carry `appliedCatalogItemId`, `appliedMode`,
`approvalVersion` and `planFingerprint`, non-null exactly when `promoted`.
`catalogItemId` stays the historical match. An inner image-preparation failure
records `diagnosticCode: "asset-processing-failed"`; other failures carry none
and stay unclassified. Readers reconcile the complete completed-job history by
candidate (`reconcileCatalogMergeCandidateApplications`): repeated reports count
once, conflicting applications and malformed version-1 results fail closed, and
a legacy approval-only outcome never supplies an id or a count.

### Application Rollout And Rollback

1. Disable promotion (`CATALOG_INTEGRATION_PROMOTION_DISABLED` or the unit-scoped
   control) and drain every scope promotion worker.
2. Deploy readers, projectors and workers that fold the two new candidate events
   before any version-1 job runs. Version-1 jobs persist under the stored kind
   `merge-candidate-promote-application-v1`, which a pre-application worker never
   claims.
3. Re-enable promotion. Retained unversioned jobs stay readable history; catch-up
   of approved-but-unapplied candidates runs only as an explicit new scope
   promotion job. A legacy promotion job still queued at cutover fails its units
   with `promotion-application-legacy-job` instead of reporting approval.

Rollback after any `promotion-planned` or `promotion-applied` event exists: stop
promotion and roll forward or keep a compatible reader. A reader that cannot
fold the new events is unsafe; do not retry with old readers or treat their
failures, skipped units or reruns as compatibility evidence.

## Evidence Packet

Record milestone evidence in the closing issue or PR, not as raw provider data in docs. The packet should include:

- scope summary: product domain, language, product form, scope level, set/expansion/series label, and redacted provider identifiers;
- selected providers and units, profile versions, readiness states, rollout-control snapshot, and option freshness/cache state;
- parent run id, child job ids, terminal states, retry state, and partial-failure diagnostics;
- Source Observation counts by provider and candidate membership counts;
- candidate ready, conflict, split, update, ignore, defer, re-sync, and partial-provider-failure screenshots or test artifacts;
- promotion preview fingerprints, command counts, blocked diagnostics, and External Catalog Item Reference versus External Product Reference evidence;
- projection-lag expectation and observed catch-up state;
- scoped test commands or CI checks used for the touched workspaces.

Do not include API keys, cookies, team ids, account identifiers, raw provider payloads, full provider URLs, provider imagery, prices, seller facts, inventory facts, screenshots exposing sensitive values, or console captures.

## Closure Gate

Before closing #2602, #2592, or milestone #54, confirm:

- #2599 evidence proves candidate-aware promotion planning from approved candidates.
- #2600 evidence proves admins can complete the scope-first workbench flow without leaving the workbench.
- #2636 evidence proves typed split/update command payloads are generated and submitted without raw JSON authoring.
- Automated coverage names the required scenarios above or links a focused follow-up issue for each accepted gap.
- Interface-only UAT evidence covers the first shippable vertical slice and rollback strategy.
- Current scoped checks pass for every touched workspace.

## Related References

- [Catalog Sync Scope Planning](./catalog-sync-scope-planning.md)
- [Source Observation Integration](./source-observation-integration.md)
- [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md)
- [Catalog Integration Rollout Controls](./catalog-integration-rollout-controls.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
