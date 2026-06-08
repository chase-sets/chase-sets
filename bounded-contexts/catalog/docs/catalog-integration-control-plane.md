# Catalog Integration Control Plane

Catalog provider integrations are a Catalog-owned control plane for turning external provider facts into reviewed Catalog truth. They are not a generic low-code provider platform, and they are not separate provider systems that bypass Source Observations and call Catalog APIs directly.

Control-plane diagnostics use the canonical [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md) so adapters, profile sections, fixtures, engine checks, jobs, read models, credential readiness, and projection lag share stable codes, severity, remediation, blocking behavior, visibility, metrics, and redaction rules. Provider-controlled payload, fixture, dry-run, diagnostic, audit, credential-readiness, and job evidence follows [Catalog Integration Data Governance](./catalog-integration-data-governance.md). Fixture repository records, coverage sufficiency, provenance, sampling, validation input selection, and activation-readiness integration are documented in [Catalog Integration Fixture Lifecycle](./catalog-integration-fixture-lifecycle.md). Provider credential ownership, storage, validation, rotation, and Admin readiness behavior is documented in [Catalog Integration Credential Readiness](./catalog-integration-credential-readiness.md). Rollout modes, feature flags, kill switches, staged enablement, rollback stops, and Admin surfacing are documented in [Catalog Integration Rollout Controls](./catalog-integration-rollout-controls.md). Provider option query caching, pagination, stale display, cache-only mode, and backpressure behavior are documented in [Catalog Integration Provider Option Query Controls](./catalog-integration-provider-option-query-controls.md). Activation, rollback, retirement, replay, and reapply workload previews are documented in [Catalog Integration Impact Analysis](./catalog-integration-impact-analysis.md). Admin Control Plane RBAC, destructive-action permissions, denied states, and confirmation safeguards are documented in [Catalog Integration Admin Control Plane RBAC](./catalog-integration-admin-control-plane-rbac.md). Metrics, alerts, logs, redaction, and runbook ownership are documented in [Catalog Integration Observability](./catalog-integration-observability.md).

## Boundary

Catalog owns the semantic control plane:

- ingestion contracts and ingestion-unit identity
- Source Observations and review lifecycle
- normalized review facts and source hashes
- external reference interpretation
- duplicate-prevention policy and candidates
- Reference Record hierarchy mapping
- promotion command plans
- replay and reapply behavior
- audit, provenance, diagnostics, and dry runs
- profile activation readiness
- rollback, deprecation, and retirement lifecycle
- Admin Control Plane workflows

Provider adapters own transport:

- authentication, credentials, sessions, and provider reachability
- provider APIs, scraping/session clients, and endpoint DTOs
- pagination, cursors, throttling, rate limits, retries, and cooldowns
- provider-specific fetch orchestration
- typed raw payload acquisition
- payload provenance and transport diagnostics

Source Observation runtime services are exposed as focused control-plane facets. Provider adapters, provider-backed import orchestration, option queries, Catalog Integration Engine behavior, provider profile authoring support, review actions, promotion/reapply, bulk review jobs, integration jobs, read queries, retention, and projectors each have their own service contract. The aggregate Source Observation runtime remains a deployable composition convenience, but route and worker seams should depend on the smallest composed facets they need.

The public Source Observation API keeps `/api/catalog/source-observations/*` as the compatibility mount while composing focused route modules underneath it. Provider profile routes, provider option/readiness routes, provider compatibility routes, promotion preview routes, bulk review job routes, integration job routes, and Source Observation read/review routes each accept only the route service facets they need. New API behavior should join the narrowest route module instead of expanding the aggregate compatibility composer.

Provider profiles describe Catalog-facing semantics for one or more ingestion units:

- profile lifecycle metadata
- supported Catalog scopes and option query declarations
- fixture coverage and validation inputs
- normalized Source Observation mapping
- source hash and merge identity rules
- external reference extraction
- selected Option evidence
- Reference Record hierarchy evidence
- duplicate-prevention order and ambiguity policy
- promotion command-plan intent

Profiles may reference reviewed named runtime functions when the generic mapping interpreter cannot yet express a rule safely. Profiles must not execute arbitrary code, carry provider credentials, or move procedural provider transport behavior into Catalog config.

Provider profile section assembly lives in the Source Observations API domain as a pure Catalog-facing boundary over versioned provider profile rows. It defines ingestion-unit identity, section value objects, activation readiness inputs, and lifecycle policies while keeping provider transport adapters unchanged. Section read models are projected from the canonical provider profile version snapshot into section and diagnostic rows with deterministic fingerprints for Admin queryability and stale-edit detection.

## Architecture Fitness Gate

A new provider can be integrated without provider-specific branches in Catalog runtime, API routes, admin page logic, promotion/reapply code, or raw JSON editor paths.

Allowed extension points are:

- provider adapter implementation
- Catalog-facing profile section definitions
- fixture payloads and fixture coverage
- section registry entries
- engine-supported semantic primitives

Adding the next provider should feel like using a purpose-built Catalog integration control plane, not carefully editing legacy Catalog integration internals.

## No-Legacy-Branch Rule

New provider behavior must not be added through:

- generic runtime conditionals
- API route branches
- admin page branches
- promotion or reapply special cases
- raw JSON authoring paths

Any remaining provider-specific branch during migration must have an owner issue, a reason it is transitional, and retirement criteria. Transitional compatibility is allowed only while migrating current TCGdex, TCGplayer, and proof-provider behavior toward the target extension points.

## Ingestion Unit Identity

An ingestion unit is the semantic unit Catalog manages through profiles, fixtures, diagnostics, readiness, jobs, Source Observations, and promotion/replay policy.

Use this identity shape:

```text
providerKey:productDomain:productCategoryOrForm[:ingestionPurpose]
```

Examples:

- `tcgdex:pokemon:single-card`
- `tcgplayer:pokemon:single-card`
- `tcgplayer:mtg:single-card`
- `tcgplayer:mtg:sealed-product`
- `reference-cards:pokemon:single-card:source-observation-proof`

Do not split raw and graded cards by default. Model raw, graded, signed, altered, damaged, grading company, grade, slab/cert number, and listing-specific evidence as condition/certification facts inside `single-card` unless provider payload shape, Catalog aggregate target, promotion plan, lifecycle, or duplicate-prevention semantics differ materially.

## Source Conflict Authority

The Catalog Integration Engine decides Catalog field winners. Provider adapters may expose timestamps, provenance, payload metadata, confidence inputs, and transport diagnostics, but they must not decide which provider fact becomes Catalog truth.

Conflict policies must be versioned and explainable. Promotion/reapply plans should name the winning value, losing values, rule identity, evidence, confidence inputs, affected fields, diagnostics, and whether the decision was automatic, blocked, additive, stale/no-op, or operator-overridden.

The final MTGJSON/Scryfall validation must include at least one source-to-source conflict scenario.

## Phase 0 Readiness

Broad implementation must wait for Phase 0 signoff. The start-gate bundle is:

- #808 Phase 0 readiness signoff
- #780 sequencing, ownership, and dependency gates
- #771 control-plane boundary
- #773 new-provider walkthrough
- #774 ProviderAdapter contract
- #775 no-legacy-branch gate
- #805 ingestion-unit identity model
- #799 first shippable vertical slice

The selected first slice is the fixture-backed `reference-cards:pokemon:single-card:source-observation-proof` ingestion unit. It must run locally or in CI without live provider dependencies before the thin real-provider proof (#800).

## Admin Readiness Contract

The Catalog Admin Control Plane exposes ingestion-unit readiness through:

```text
GET /api/catalog/source-observations/integration-control-plane/readiness
```

The response is grouped by ingestion unit and includes:

- active rollout controls and kill-switch evidence for the control plane.
- `unitKey`, provider, product domain, product form, ingestion purpose, display name, and proof profile version.
- Catalog semantic readiness, provider transport readiness, fixture validation status, and dry-run status.
- Diagnostic counts by severity plus the latest diagnostic text.
- Structured dry-run Source Observation evidence, including external key, source URL, source hash, and normalized facts.

The Phase 1 reference record is `reference-cards:pokemon:single-card:source-observation-proof`. It is fixture-backed, has no live transport dependency, and runs through the ProviderAdapter registry plus the Catalog Integration Engine before the Admin UI reports it as ready. Future live provider readiness should use the same contract while keeping provider transport details on adapters and Catalog semantic readiness on ingestion units.

The Phase 4 thin real-provider proof (#800) uses `tcgdex:pokemon:single-card:source-observation-import`. The readiness path resolves dry-run proof runners from a registry keyed by `unitKey`, so adding the real-provider proof did not add another provider-specific runtime or route branch. The TCGdex proof uses the real TCGdex ProviderAdapter and Catalog Integration Engine with deterministic fixture `fetch` responses for one Expansion scope and one card payload. This keeps CI and readiness deterministic while validating the real provider payload shape, provenance, and normalized Source Observation facts. The current TCGdex adapter does not emit a payload content hash in its provenance envelope; readiness shows `sourceHash: null` for that proof until provider payload hashing is implemented against the governed hash material and retention rules in [Catalog Integration Data Governance](./catalog-integration-data-governance.md).

## Admin Query Contract

Admin workflow modules consume stable query/read-model contracts from Source Observations. The contract inventory is documented in [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md), and the authoritative TypeScript surface is `admin-control-plane-read-model-contracts.ts`.

Those contracts keep Catalog semantic readiness grouped by ingestion unit, provider transport readiness grouped by provider/adapter, and all profile, job, Source Observation, diagnostic, promotion, replay/reapply, lifecycle, and audit read models attributed to `unitKey`. New providers, product domains, or product forms should flow through generic ingestion-unit fields rather than creating admin page branches.

Read-model performance and freshness expectations are documented in [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md), with the authoritative TypeScript surface in `admin-control-plane-read-model-slos.ts`. High-volume diagnostic, job, Source Observation, impact, promotion, rollback, and audit views must carry server-side pagination contracts and render `fresh`, `stale`, `lagging`, `partial`, or `unavailable` states instead of silently falling back to raw storage reads.

Dense workflow UX and accessibility acceptance is documented in [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md). Release verification for Admin Control Plane UI changes should name the checklist rows covered by tests and any deferred keyboard, responsive, high-volume, or raw-JSON fallback gaps.

Operator acceptance journeys are documented in [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md). Release verification should name the journey IDs covered by happy-path, failure/recovery, destructive lifecycle, and audit evidence so operator acceptance remains distinct from low-level UI accessibility checks.

## Admin Section Command Contract

Provider profile section updates use the shared `provider-profile-admin-contracts` module under Source Observations. That compatibility contract delegates to the provider profile section registry, where each editable section entry owns its display metadata, command validator, and patch composer. The Hono route parses section update commands before invoking review services, and the Admin UI imports the same section key and command DTO types instead of maintaining a duplicate union. Invalid section commands return HTTP 400 with `invalid_profile_section_command` and a stable validation message.

The URL section key is authoritative for section update routes. Request bodies may be wrapped in `{ "command": ... }` for compatibility, but normal Admin Control Plane workflows should send typed section commands rather than raw profile JSON snapshots.

## Related Docs

- [Provider Integration Profiles](./provider-integration-profiles.md)
- [Provider Integration Mapping Contract](./provider-integration-mapping-contract.md)
- [Provider Integration Admin Module](./provider-integration-admin-module.md)
- [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md)
- [Catalog Integration Data Governance](./catalog-integration-data-governance.md)
- [Catalog Integration Fixture Lifecycle](./catalog-integration-fixture-lifecycle.md)
- [Catalog Integration Rollout Controls](./catalog-integration-rollout-controls.md)
- [Catalog Integration Provider Option Query Controls](./catalog-integration-provider-option-query-controls.md)
- [Catalog Integration Impact Analysis](./catalog-integration-impact-analysis.md)
- [Catalog Integration Observability](./catalog-integration-observability.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Source Observation Integration](./source-observation-integration.md)
- [Catalog Integration New-Provider Walkthrough](./catalog-integration-new-provider-walkthrough.md)
- [Catalog Integration Milestone Release Plan](./catalog-integration-milestone-release-plan.md)
- [Source Conflict Resolution](./source-conflict-resolution.md)
