# Catalog Integration Milestone Release Plan

This plan sequences milestone 7 into dependency-ordered phases. It complements the generated Codex plan and is durable documentation for contributors.

## Release Rule

Do not begin broad runtime, API, admin UI, provider migration, or promotion/replay decomposition until Phase 0 signoff (#808) is complete.

Phase 0 is complete only when contributors can answer:

- what starts first
- which issue cluster owns each decision
- what is blocked
- what can proceed in parallel
- what proves the architecture gate is satisfied
- what proves the first reference slice is shippable

The release must preserve the control-plane boundary throughout implementation and rollout:

- Catalog owns Source Observations, semantic mapping, duplicate prevention, promotion/reapply, replay, audit, diagnostics, admin lifecycle, and release evidence.
- Provider adapters own authentication, provider APIs or scraping/session behavior, pagination, rate limits, retries, target planning, raw payload acquisition, and transport diagnostics.
- Provider profiles describe Catalog-facing semantics for specific ingestion units. They must not become a low-code replacement for provider client implementation, provider auth, throttling, scraping, or procedural provider workflows.
- Ingestion units split by Catalog semantic shape, not by every provider listing variant. Raw, foil, graded, certified, and similar card differences stay inside condition, certification, selected Option, or evidence sections unless a separate unit proves distinct aggregate targets, lifecycle, duplicate-prevention policy, or promotion plan.
- Source Observations remain the normal integration path. External provider systems must not bypass Source Observations and write Catalog truth directly.

## Phase 0: Readiness And Architecture Gate

Owner area: Catalog source-observations.

Start-gate issues:

- #808 Phase 0 readiness signoff
- #780 sequencing, ownership, and dependency gates
- #771 control-plane boundary
- #773 new-provider walkthrough
- #774 ProviderAdapter contract
- #775 no-legacy-branch gate
- #805 ingestion-unit identity model
- #799 first shippable vertical slice

Required decisions:

- Boundary: Catalog owns semantics; provider adapters own transport; profiles own Catalog-facing semantics.
- First slice: `reference-cards:pokemon:single-card:source-observation-proof`.
- Legacy integration data: default to wipe/reset/rebuild for unlaunched data; document retained-data exceptions.
- Raw JSON: deprecated/internal only, not required for supported operator workflows.
- Governance: provider payload sampling, fixtures, dry-run output, diagnostics, and retention follow [Catalog Integration Data Governance](./catalog-integration-data-governance.md) and require policy/legal signoff before live provider sampling.

## Phase 1: Reference Slice And Engine Boundary

Owner area: Catalog source-observations API/runtime.

Primary issues:

- #772 Catalog Integration Engine boundary
- #774 ProviderAdapter contract
- #776 reference provider spike
- #799 first shippable vertical slice
- #805 ingestion-unit identity model

Exit criteria:

- The reference adapter and registry work without provider-specific switch branches.
- The selected ingestion unit has active/test profile semantics and fixture coverage.
- The engine produces Source Observation facts, diagnostics, duplicate-prevention evidence, and promotion-plan preview data through allowed extension points.
- Local or CI verification runs without live provider dependencies.

## Phase 2: System Seams

Owner area: Catalog source-observations API, persistence, read models, and operations.

Primary issues:

- #758 section-level persistence/read models
- #759 shared typed admin contracts and schemas
- #762 SourceObservationServices facets
- #781 query/read-model contracts
- #783 audit and evidence model
- #784 fixture repository and sampling lifecycle
- #791 idempotency, concurrency, and job consistency
- #792 migration/reset/backfill/rollback implementation
- #793 schema versioning and compatibility, documented in [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md)
- #794 provider payload and diagnostics data governance, documented in [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- #795 read-model performance and freshness SLOs
- #796 diagnostic taxonomy
- #797 option query caching, pagination, and backpressure, documented in [Catalog Integration Provider Option Query Controls](./catalog-integration-provider-option-query-controls.md)
- #798 activation/replay impact analysis
- #807 source conflict resolution and field precedence

Exit criteria:

- Runtime services are split behind focused facets, with the aggregate runtime kept only as deployable composition convenience.
- The Source Observation API is composed from focused subrouters behind the existing `/api/catalog/source-observations/*` compatibility mount.
- API contracts and read models are typed by provider/profile/ingestion unit, with the Admin query inventory documented in [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md) and performance/freshness expectations documented in [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md).
- Diagnostics use the canonical [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md) for codes, severity, remediation, blocking behavior, visibility, metrics, and evidence/redaction policy.
- Jobs, Source Observations, audit records, diagnostics, and read models carry ingestion-unit identity.
- Job idempotency, lifecycle concurrency, retry/resume, partial-failure, and deploy-skew guarantees are defined in [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md).
- Schema compatibility distinguishes launched or intentionally retained data from resettable pre-launch profile, payload, fixture, job, and projection data.
- Migration/reset/backfill/rollback execution is defined in [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md), and retained legacy cleanup exceptions are defined in [Catalog Integration Legacy Cleanup](./catalog-integration-legacy-cleanup.md).
- Conflict-aware promotion/reapply plans are deterministic and explainable.

## Phase 3: Admin Control Plane

Owner area: Catalog source-observations UI and design-system/local admin components.

Primary issues:

- #763 Admin Control Plane shell and workflow modules
- #764 dirty-section editing and section-scoped saves
- #765 profile section registry and lazy-loaded editor framework
- #766 dense workflow primitives
- #768 semantic diagnostics, readiness, and compare models
- #777 health, adapter readiness, and audit views
- #778 fixture validation, dry-run, compare, and activation workflows
- #779 import, observation review, promote/reapply, and retirement workflows
- #788 RBAC and destructive-action permissions
- #790 UX and accessibility acceptance
- #802 operator acceptance journeys

Exit criteria:

- Operators can complete supported authoring, validation, dry-run, activation, import, review, promote/reapply, rollback, and retirement workflows without raw JSON editing.
- View/manage permission boundaries are visible in UI and enforced server-side by both deployable host middleware and Catalog-owned control-plane route guards.
- Dense workflows pass UX, accessibility, and operator journey checks.

## Phase 4: Provider Migration And Proofs

Owner area: Catalog provider adapters and integration units.

Primary issues:

- #767 provider migration coordination
- #785 TCGdex ProviderAdapter migration
- #786 TCGplayer ProviderAdapter migration
- #800 thin real-provider ingestion-unit proof
- #806 MTGJSON and Scryfall final validation

Exit criteria:

- Current providers are behind ProviderAdapter boundaries or have reviewed extension points with removal criteria. Retired compatibility branches are launch blockers until completely deleted.
- #785 moves TCGdex option queries and Expansion import payload acquisition behind the registered `tcgdex` ProviderAdapter. Remaining TCGdex variant expansion, external-reference extraction, Reference Record hierarchy provisioning, and promotion command planning are Catalog semantic helpers referenced by the executable profile contract; they are deterministic, fixture-backed, and reviewed extension points until generic profile interpretation can express them safely. Replacing one requires complete deletion of the old helper, tests, fixtures, docs, runbooks, and operator instructions.
- #786 moves TCGplayer product-line, set-name, product, SKU option queries and Product/Set import payload acquisition behind the registered `tcgplayer` ProviderAdapter. The implemented profile-backed unit is `tcgplayer:pokemon:single-card:source-observation-import`; MTG single-card, MTG sealed-product, and One Piece single-card remain future split units until dedicated profile versions exist. Remaining TCGplayer product-form, barcode, selected Option, external-reference, duplicate-prevention, Reference Record hierarchy, and promotion-readiness helpers are reviewed Catalog semantic extension points with removal criteria in the provider profile docs.
- #800 proves the target architecture with `tcgdex:pokemon:single-card:source-observation-import`: the Admin readiness path resolves a dry-run proof by `unitKey`, the proof runs the real TCGdex ProviderAdapter and Catalog Integration Engine with deterministic fixture transport, and readiness exposes normalized Source Observation evidence without adding provider-specific runtime/API/admin/promotion branches.
- #806 MTGJSON and Scryfall validation passes the no-core-change gate and includes source-conflict evidence, documented in [Catalog Integration MTGJSON And Scryfall Validation](./catalog-integration-mtgjson-scryfall-validation.md). The validation proves `mtgjson:mtg:single-card:reference-data`, `mtgjson:mtg:set:reference-data`, `scryfall:mtg:single-card:reference-data`, and `scryfall:mtg:single-card:image-evidence` through ProviderAdapter extension points and Catalog Integration Engine dry-runs without registering production runtime branches. Production enablement remains gated by provider-data governance and policy/legal signoff.

## Phase 5: Release Hardening And Production

Owner areas: Catalog, Ops, Security, and Release.

Primary issues:

- #770 migration and release plan
- #787 observability and runbooks, documented in [Catalog Integration Observability](./catalog-integration-observability.md) and [Catalog Integration Operations](../../../docs/runbooks/catalog-integration-operations.md)
- typed profile authoring coverage
- #801 rollout modes, feature flags, and kill switches, documented in [Catalog Integration Rollout Controls](./catalog-integration-rollout-controls.md)
- #798 activation, rollback, retirement, replay, and reapply impact analysis, documented in [Catalog Integration Impact Analysis](./catalog-integration-impact-analysis.md)
- #803 provider-data policy/legal signoff, documented in [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- #1050/#1055 Stage 0 cleanup gate and clean-contract handoff
- #1090 complete deletion of old Catalog integrations pages after rebuilt workbench acceptance

Exit criteria:

- Release verification covers empty integration-data bootstrap, reset/migration, rollback, schema/deploy skew, idempotency, launch API contracts, adapter/engine behavior, conflict precedence, admin workflows, credentials, audit/evidence, fixtures, governance/redaction/signoff, read-model freshness, diagnostics, backpressure, impact analysis, observability, RBAC, raw JSON retirement, UX/accessibility, operator journeys, E2E smoke tests, and worker/job verification.
- Observability verification covers provider option query metrics, integration job metrics, bulk review work-unit metrics, worker/request/projection platform metrics, redaction checks, alert starter conditions, and the [Catalog Integration Operations](../../../docs/runbooks/catalog-integration-operations.md) incident flows.
- Legacy cleanup verification covers zero old Source Observations, zero legacy profile references, empty integration and bulk-review jobs/work units, rebuilt seeded profiles, rebuilt profile sections, `rawJsonBacked=false` section editors, and proof that every retired compatibility path is completely deleted or explicitly launch-blocking.
- No unresolved P0-P2 release hardening findings remain.
- Rollout controls expose default-open staged modes, provider/API emergency stops, import/promotion/reapply/activation kill switches, worker stops, Admin surfacing, and rollback evidence.
- CI passes before merge queue entry.
- Staging and production deployments are verified green after merge and rollout.

## Launch Execution Order

Use this order for the first broad Catalog Integration Control Plane launch. Later provider launches can reuse the same order by substituting the provider-specific migration and fixture evidence.

1. Confirm Phase 0 readiness signoff (#808), architecture gates, ownership map, and dependency gates from #780.
2. Confirm the first shippable vertical slice (#799) remains green and that no broad implementation relies on raw JSON editing or provider-specific runtime, API, admin, promotion, or replay branches outside reviewed extension points. Any retired compatibility branch is launch-blocking until completely deleted.
3. Confirm ingestion-unit identity is present for every touched Source Observation, job, diagnostic, audit record, read model, fixture run, option query, adapter proof, and Admin state (#805).
4. Confirm the ProviderAdapter contract and ownership model (#774) are the only provider transport extension path for new provider work.
5. Confirm the Catalog Integration Engine responsibility model (#772) owns Source Observation normalization, diagnostics, duplicate-prevention evidence, conflict-aware promotion/reapply plans, and replay behavior.
6. Confirm the Admin Control Plane workflow map is covered by query contracts, read-model SLOs, RBAC, UX/accessibility acceptance, and operator journeys (#763, #777, #778, #779, #781, #788, #790, #795, #802).
7. Confirm the section registry contract owns editable section metadata, typed command validation, patch composition, diagnostics, and `rawJsonBacked=false` status for normal sections.
8. Confirm data governance and legal/policy signoff before live provider sampling, retained payloads, dry-run output retention, raw provider evidence display/export, or MTGJSON/Scryfall live enablement (#794, #803).
9. Run the pre-launch reset or retained-data migration procedure from [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md).
10. Rebuild seeded provider profile versions, section snapshot/read-model rows, section diagnostics, fixture coverage, and integration summary projections from canonical Catalog data.
11. Verify provider adapters and integration units in dependency order: reference proof, TCGdex, TCGplayer, thin real-provider proof, then MTGJSON/Scryfall validation (#776, #785, #786, #800, #806).
12. Enable rollout controls in staged mode with provider/API emergency stops, import, promotion, reapply, activation, worker, and rollback switches available (#801).
13. Run the release verification checklist below in staging, then repeat production smoke, canary, branch, and observability evidence after production deploy.

## Migration And Reset Strategy

Because this control plane has not broadly launched, the default migration strategy is wipe/reset/rebuild for pre-launch integration data instead of preserving old integration rows or carrying permanent compatibility code paths.

Resettable data:

- non-admin-authored provider profile rows without launch-retained migration evidence
- profile section projections and section diagnostics
- pre-launch fixture, dry-run, option-query cache, integration summary, bulk review, and job read models
- pre-launch Source Observations and promotion/reapply work units that have not been intentionally retained
- raw JSON editor artifacts that are not needed for signed launch evidence

Retained data is the exception. It requires an owner, reason, launch gate, removal date or removal condition, retention mode, rollback behavior, and verification query. Retained data is allowed only when it is launched data, intentionally retained operator evidence, or deploy-skew safety required to keep a release safe. Retired compatibility paths are not retained data.

Backfill is required only for retained data. It must run after reset and before activation so retained Source Observations, jobs, diagnostics, audit records, and profile versions carry ingestion-unit identity, schema compatibility metadata, redaction-safe evidence, and conflict-precedence policy names.

Compatibility and deploy-skew behavior must stay narrow:

- stable launch mounts may preserve API callers during deploy skew, but old mounts must either remain launched contracts or fail closed with documented operator-safe errors
- section snapshot/read-model tables are query infrastructure rebuilt from canonical provider profile versions; they must not become a second source of profile truth
- broad raw JSON patching is retired as a normal operator workflow; section-scoped typed commands are the launch workflow
- provider-specific semantic helpers may remain only when the executable profile contract references them by reviewed function key and the helper has fixture coverage plus removal criteria
- provider transport deploy-skew belongs in ProviderAdapters, not Catalog profile config or deployable branches

## Release Verification Checklist

Before merge queue entry for a launch PR or any provider-enablement PR, capture evidence for each applicable item in the PR body.

- Phase 0 readiness signoff, ownership map, dependency gates, and first-slice validation are current (#808, #780, #799).
- Architecture fitness gate passes: no new provider-specific runtime, API route, admin page, promotion, replay, or raw JSON branches outside allowed extension points (#775).
- Ingestion-unit identity is present and verified across provider/profile/job/diagnostic/audit/read-model/fixture surfaces (#805).
- ProviderAdapter verification proves credential readiness, option queries, target planning, payload acquisition envelopes, retries/backpressure, and transport diagnostics without Catalog semantic decisions (#774, #782, #797).
- Catalog Integration Engine verification proves Source Observation normalization, diagnostics, duplicate prevention, Source Observation hash behavior, promotion-plan preview, replay/reapply impact analysis, and conflict precedence (#772, #798, #807).
- Empty integration-data bootstrap is verified: seeded active/test profiles, profile sections, fixture coverage, diagnostics, summary projections, and adapter readiness rebuild from canonical sources.
- Pre-launch reset verification confirms no stale Source Observations, legacy profile references, integration jobs, bulk-review work units, raw JSON authoring dependencies, or retired compatibility paths remain (#1054, #1055).
- Retained-data backfill verification runs only for documented retained data and proves schema compatibility, ingestion-unit identity, redaction, audit, and rollback behavior (#793).
- API and deploy-skew checks prove old mounts either remain stable launched contracts or fail closed with documented operator-safe errors.
- Idempotency and concurrency checks cover activation, rollback, deprecation, retirement, imports, reapply, promotion, retry/resume, partial failure, and active-job conflicts (#791).
- Admin workflows pass guided profile authoring, fixture validation, dry run, semantic compare, activation readiness, import, Source Observation review, promote/reapply, rollback, retirement, impact preview, and audit/evidence journeys without raw JSON editing (#763, #777, #778, #779, #802).
- Section registry and section read-model checks prove editable section metadata, typed commands, validation, patch composition, diagnostics, snapshot rebuild, stale-edit etags, and `rawJsonBacked=false` normal authoring paths.
- Admin query/read-model checks prove freshness, pagination, indexing, degraded states, stale projection messaging, and performance SLOs (#781, #795).
- RBAC checks prove `catalog.view` and `catalog.manage` action boundaries, denied states, destructive-action confirmation, and audit metadata (#788).
- Data governance checks prove payload retention, fixture retention, dry-run retention, diagnostic retention, redaction, logging, export behavior, and provider-data policy/legal signoff (#794, #803).
- Fixture lifecycle checks prove required flows, sampling coverage, provenance, fixture-set versioning, activation-readiness use, and unsafe evidence blocking (#784).
- Diagnostic taxonomy checks prove codes, severity, blocking behavior, remediation, visibility, metric names, and redaction policy (#796).
- Option-query checks prove caching, TTL, pagination, stale fallback, backpressure, degraded display, and provider emergency-stop behavior (#797).
- Observability checks prove provider option query metrics, integration job metrics, bulk review work-unit metrics, worker/request/projection metrics, starter alerts, redaction-safe logs, and incident runbook coverage (#787).
- Rollout-control checks prove staged modes, provider/API emergency stops, activation/import/promotion/reapply/worker kill switches, Admin surfacing, rollback evidence, and default state (#801).
- UX/accessibility checks prove dense workflow layout, responsive behavior, keyboard navigation, focus management, disabled-state explanations, and no overlapping UI text (#790).
- E2E smoke and worker/job checks prove admin protected routes, health endpoints, provider readiness, durable job progress, projection lag handling, and worker resume behavior.
- Final provider proof checks pass in order: reference provider, TCGdex, TCGplayer, thin real-provider proof, MTGJSON/Scryfall no-core-change validation (#776, #785, #786, #800, #806).

## Rollback Plan

Rollback is a controlled Catalog lifecycle action, not a direct provider rewrite.

1. Stop or pause new activation, import, promotion, and reapply work through rollout controls and worker kill switches.
2. If the problem is provider transport, disable the affected provider adapter or API surface and leave Catalog profile semantics intact.
3. If the problem is profile semantics, activate the prior validated profile version and deprecate the bad version. Do not edit historical profile rows in place.
4. If the problem is migrated retained data, restore the last verified retained-data snapshot or rerun the retained-data backfill rollback path from [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md).
5. If the problem is pre-launch reset output, rerun the wipe/rebuild procedure from canonical seeds and fixture coverage instead of preserving partial reset artifacts.
6. Reapply or replay only through the Catalog Integration Engine so Source Observations, audit, diagnostics, duplicate-prevention evidence, conflict precedence, and command plans remain deterministic.
7. Verify production health, protected Admin/API behavior, integration job queues, projection freshness, provider readiness, observability, and audit evidence before reopening rollout switches.

Rollback evidence must include the triggering diagnostic or incident, the affected provider/profile/ingestion unit, active jobs, profile version before and after rollback, impacted Source Observation count, whether Catalog Items were touched, and the smoke/canary result after rollback.

## Final Go/No-Go Gate

The milestone is ready to close only when:

- #770 has captured this release plan in durable docs and shipped to production.
- All milestone 7 child issues are closed or explicitly moved out of scope with owner-approved rationale.
- #756 acceptance criteria are still satisfied against the merged production state.
- `origin/main` and `origin/production` point at the release commit or the deployment workflow records an intentional no-runtime-deploy decision.
- Production smoke checks pass for readiness health, protected integration APIs, and the Catalog Integrations admin route.
- No unresolved P0-P2 release hardening findings remain.

## Dependency Map

- #808 gates broad work and operationalizes #780.
- #771, #773, #774, #775, and #805 gate #799.
- #799 gates broad #763, #777, #778, #779, #785, #786, and #800 work.
- #759, #758, #781, and #795 gate Admin Control Plane UI work; #781 contributes the stable Admin query/read-model contract inventory, and #795 contributes latency, pagination, indexing, freshness, and degraded-state SLOs for that inventory.
- #796 gates #768 diagnostics/readiness UX.
- #794 and #803 gate live provider sampling, fixture retention, dry-run retention, diagnostics retention, raw provider evidence display/export, and MTGJSON/Scryfall sampling.
- #807 gates final #806 validation and release completion.
- #1054 and #1055 gate prelaunch reset/drop evidence and clean-contract handoff. #1090 owns complete deletion of old Catalog integrations pages, modules, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions after the rebuilt workbench is accepted.
- #775 and #1053 gate no-legacy-branch and no-raw-JSON release readiness.

## Parallel Work After Phase 0

These clusters can proceed in parallel only after their upstream gates are satisfied:

- ProviderAdapter and engine contract work: #772, #774, #776.
- Persistence/read-model/API contracts: #758, #759, #781, #795.
- Diagnostics and fixture semantics: #784, #796, #768.
- Governance/security/credentials: #782, #794, #803.
- Admin workflow shell and primitives: #763, #765, #766 after contracts are stable.
- Release and observability: #770, #787, #801.

## PR Checklist For This Milestone

- The PR states which phase and issues it advances.
- The PR states whether Phase 0 gates are satisfied or why the change is Phase 0-only.
- New provider behavior uses only allowed extension points.
- Provider-specific branches outside allowed extension points are listed with owner issue and retirement criteria.
- No normal operator workflow depends on raw JSON editing.
- Source Observations, jobs, diagnostics, audit, read models, and admin state carry ingestion-unit identity when they touch the control plane.
- Conflict precedence impact is documented for any promotion/reapply behavior.
- Provider payload, fixture, dry-run, diagnostic, audit, job, logging, export, and Admin visibility behavior follows data-governance policy and signoff gates.
- Targeted verification and release-hardening findings are included in the PR body.
