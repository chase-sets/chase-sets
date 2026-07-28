# Catalog Integration New-Provider Walkthrough

This walkthrough is the architecture fitness benchmark for adding a provider through the Catalog integration control plane.

The example provider is `reference-cards`, using the Phase 0 proof ingestion unit:

```text
reference-cards:pokemon:single-card:source-observation-proof
```

It is fixture-backed and has no live provider dependency. The real-provider proof follows with the launch-selected TCGdex adapter and a redacted evidence packet.

## Target Flow

1. Add a provider adapter implementation for `reference-cards`.
2. Register the adapter by `providerKey` in the adapter registry.
3. Declare the `reference-cards:pokemon:single-card:source-observation-proof` ingestion unit.
4. Define Catalog-facing profile sections for the ingestion unit.
5. Add fixtures for normal, partial, changed, ambiguous, replay, and unsafe-evidence cases.
6. Run profile validation through the fixture harness.
7. Plan an import or dry run through the adapter.
8. Pass typed provider payloads and provenance into the Catalog Integration Engine.
9. Let profile semantics produce normalized Source Observation facts, source hash material, merge identity, external references, selected Option evidence, Reference Record hierarchy evidence, duplicate-prevention candidates, diagnostics, and optional promotion-plan previews.
10. Show readiness, dry-run, diagnostics, and audit evidence in the Admin Control Plane.
11. Create or simulate Source Observations through the engine.
12. Reapply/replay by profile version, policy version, observation set, and operator override set.

## File And Module Map

Provider adapter implementation:

- `bounded-contexts/catalog/features/source-observations/api/provider-adapters/<provider-key>.ts`
- Owns auth/session checks, transport option queries, import plans, fetches, pagination, rate limits, typed payloads, provenance, and transport diagnostics.

Provider adapter registry:

- `bounded-contexts/catalog/features/source-observations/api/provider-adapters/registry.ts`
- Resolves adapters by provider key without runtime switch branches.

ProviderAdapter contract:

- `bounded-contexts/catalog/features/source-observations/api/provider-adapters/provider-adapter.ts`
- Defines provider capabilities, ingestion-unit listing, option query planning, import planning, payload fetching, and transport diagnostics.

Ingestion-unit and profile sections:

- `bounded-contexts/catalog/features/source-observations/api/provider-integration-mapping-contract.ts`
- `bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts`
- `bounded-contexts/catalog/features/source-observations/api/providers/provider-profile-review.ts`
- Own Catalog-facing semantics, lifecycle, section commands, fixture coverage, mapping, duplicate prevention, promotion planning, and readiness diagnostics.

Catalog Integration Engine:

- `bounded-contexts/catalog/features/source-observations/api/catalog-integration-engine.ts`
- Owns Source Observation production, diagnostics, duplicate-prevention evaluation, replay/reapply planning, conflict-policy evaluation, and promotion-plan preparation.

Fixtures:

- `bounded-contexts/catalog/features/source-observations/api/__fixtures__/<provider-key>/`
- Cover provider payload examples, expected safe normalized evidence, diagnostics, and replay cases.

API route composition:

- `bounded-contexts/catalog/features/source-observations/api/route.ts`
- Should delegate to provider-profile, options, jobs, and review subrouters without provider-specific branches.

Admin Control Plane UI:

- `bounded-contexts/catalog/features/source-observations/ui/`
- Should load provider/profile/ingestion-unit metadata, registry-driven section editors, readiness, dry-run, diagnostics, lifecycle, and job state without provider-specific page logic.

## Provider Adapter Responsibilities

The adapter owns:

- provider key and transport capabilities
- supported ingestion units from the provider side
- credential/session readiness
- option query transport
- import scope planning
- provider HTTP, scraping, or session operations
- pagination and cursor traversal
- retries, cooldowns, and throttling diagnostics
- typed payload DTOs
- provenance for payloads and source timestamps
- transport diagnostics

The adapter does not own:

- Source Observation lifecycle
- source hash semantics
- normalized Catalog review facts
- duplicate-prevention winners
- Reference Record hierarchy mapping
- promotion command planning
- conflict resolution
- profile activation
- Admin Control Plane workflow state

## Catalog Profile And Engine Responsibilities

Profiles and the engine own:

- ingestion-unit identity and active profile version
- fixture-backed validation
- provider payload selectors and safe transforms
- redaction and unsafe evidence policy
- Source Observation identity, normalized facts, and hashes
- external Catalog Item and Product reference evidence
- selected Option evidence
- Reference Record hierarchy evidence
- duplicate-prevention order and ambiguity handling
- conflict policy evaluation
- promotion and reapply command-plan evidence
- readiness diagnostics
- replay determinism

## Prohibited Edit Points

Adding `reference-cards` or any future provider must not require provider-specific edits in:

- generic Catalog runtime conditionals
- API route branches
- admin page branches
- promotion or reapply special cases
- raw JSON authoring paths
- deployable-owned provider lookup routes

If a provider requires new behavior, add it through the adapter contract, a Catalog-facing profile section, fixture coverage, a section registry entry, or a shared engine semantic primitive. If none of those is enough, add the primitive explicitly and prove it with the reference provider before using it for a live provider.

## Readiness Checks

The first slice passes when:

- the adapter registry resolves `reference-cards` without a switch branch
- the adapter lists `reference-cards:pokemon:single-card:source-observation-proof`
- fixture validation runs without live provider calls
- the engine produces Source Observation facts and diagnostics tagged with the ingestion unit
- dry-run output is inspectable without raw JSON editing
- the Admin Control Plane can show health/readiness by ingestion unit
- tests prove no provider-specific runtime/API/admin/promotion branches were added outside allowed extension points

## Real-Provider Follow-Up

After the reference slice passes, the real-provider proof adds one real-provider run using `tcgdex:pokemon:single-card:source-observation-import`. The real-provider slice must keep the same architecture shape and should treat live transport, provider-data policy, fixture retention, redaction, promotion-preview counts, and legal/policy gates as explicit readiness inputs rather than hidden implementation details. It must not add provider-specific runtime/API/Admin/promotion branches, retired control-plane paths, raw provider payload shortcuts, or compatibility redirects.
