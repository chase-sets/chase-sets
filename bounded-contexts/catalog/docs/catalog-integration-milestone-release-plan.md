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
- Governance: provider payload sampling, fixtures, dry-run output, diagnostics, and retention require policy/legal signoff before live provider sampling.

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
- #794 provider payload and diagnostics data governance
- #795 read-model performance and freshness SLOs
- #796 diagnostic taxonomy
- #797 option query caching, pagination, and backpressure
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
- View/manage permission boundaries are visible in UI and enforced server-side.
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

- Current providers are behind ProviderAdapter boundaries or have documented transitional exceptions with retirement criteria.
- One thin real-provider ingestion unit proves the target architecture.
- MTGJSON and Scryfall validation pass the no-core-change gate and include source-conflict scenarios.

## Phase 5: Release Hardening And Production

Owner areas: Catalog, Ops, Security, and Release.

Primary issues:

- #770 migration and release plan
- #787 observability and runbooks
- #789 raw JSON fallback retirement
- #801 rollout modes, feature flags, and kill switches
- #803 provider-data policy/legal signoff
- #804 legacy data and compatibility cleanup

Exit criteria:

- Release verification covers empty integration-data bootstrap, reset/migration, rollback, compatibility/deploy skew, idempotency, API compatibility, adapter/engine behavior, conflict precedence, admin workflows, credentials, audit/evidence, fixtures, governance/redaction, read-model freshness, diagnostics, backpressure, impact analysis, observability, RBAC, raw JSON retirement, UX/accessibility, operator journeys, E2E smoke tests, and worker/job verification.
- Legacy cleanup verification covers zero old Source Observations, zero legacy profile references, empty integration and bulk-review jobs/work units, rebuilt seeded profiles, rebuilt profile sections, `rawJsonBacked=false` section editors, and an owner/reason/removal-date launch gate for every retained compatibility path.
- No unresolved P0-P2 release hardening findings remain.
- CI passes before merge queue entry.
- Staging and production deployments are verified green after merge and rollout.

## Dependency Map

- #808 gates broad work and operationalizes #780.
- #771, #773, #774, #775, and #805 gate #799.
- #799 gates broad #763, #777, #778, #779, #785, #786, and #800 work.
- #759, #758, #781, and #795 gate Admin Control Plane UI work; #781 contributes the stable Admin query/read-model contract inventory, and #795 contributes latency, pagination, indexing, freshness, and degraded-state SLOs for that inventory.
- #796 gates #768 diagnostics/readiness UX.
- #794 and #803 gate live provider sampling, fixture retention, dry-run retention, diagnostics retention, and MTGJSON/Scryfall sampling.
- #807 gates final #806 validation and release completion.
- #804, #792, and #793 gate launch migration, reset, and compatibility decisions. #792 provides the executable pre-launch wipe/rebuild policy and verification queries; #804 provides the retained legacy path inventory and clean-start checklist.
- #775 and #789 gate no-legacy-branch and no-raw-JSON release readiness.

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
- Provider payload, fixture, dry-run, and diagnostic retention follow data-governance policy.
- Targeted verification and release-hardening findings are included in the PR body.
