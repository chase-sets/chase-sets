# Catalog Integration Test Architecture

Catalog Integration Control Plane tests should prove the decomposed boundaries directly instead of pushing every behavior through the Integration Management page.

## Boundary Map

| Boundary | Owner | Primary Coverage |
| --- | --- | --- |
| Provider transport adapters | Provider adapter code | `features/source-observations/api/provider-adapters/provider-adapter.test.ts` |
| Catalog Integration Engine semantics | Catalog Source Observations | `features/source-observations/api/catalog-integration-engine.test.ts` |
| Provider profile contracts and section parsing | Catalog Source Observations | `features/source-observations/api/provider-profile-contract-harness.test.ts`, `provider-profile-admin-contracts.test.ts`, `provider-profile-section-registry.test.ts`, `provider-profile-section-projection.test.ts` |
| Runtime facets and jobs | Catalog Source Observations | `features/source-observations/api/runtime-service-facets.test.ts`, `runtime.test.ts` |
| API permissions, validation, rollout, and streams | Catalog Source Observations API | `features/source-observations/api/route.test.ts` |
| Admin Control Plane profile preview helpers | Catalog Source Observations UI | `features/source-observations/ui/integration-management-profile-previews.test.ts` |
| Admin Control Plane rendered workflows | Catalog Source Observations UI | `features/source-observations/ui/integration-management-page.test.tsx` |
| Source Observation review UI | Catalog Source Observations UI | `features/source-observations/ui/source-observation-list-page.test.tsx` |
| Operator journeys and E2E smoke | Catalog acceptance and deployable E2E | `tests/operator-acceptance-journeys.test.ts`, `deployables/admin-web/e2e/catalog-integrations.spec.ts` |

## Rules

- Provider adapter tests may assert auth/session state, option transport, pagination, rate-limit diagnostics, typed payload acquisition, and provenance. They must not assert Catalog promotion, replay, duplicate-prevention, or Admin page behavior.
- Catalog Integration Engine tests may assert Source Observation facts, diagnostics, profile interpretation, duplicate-prevention evidence, dry-run output, conflict policy, and promotion/reapply primitives. They must not depend on live provider transport.
- API route tests may assert request validation, permissions, compatibility/quarantine paths, rollout evidence, job event streams, and service delegation. They should use stubbed services rather than provider network calls.
- Runtime facet tests may prove the aggregate runtime still exposes focused service contracts for provider adapters, imports, provider options, profile admin, engine readiness, review, promotion/reapply, bulk review jobs, integration jobs, and reads.
- UI profile preview tests own pure form-to-preview behavior for provider options, external references, reference hierarchy, duplicate prevention, and promotion command plans.
- Page tests own rendered operator workflows, dialog state, permissions, lifecycle actions, job progress, and navigation. They should not be the default home for pure profile-section helper behavior.
- E2E tests cover representative happy paths and critical blocked states. They do not own every section editor behavior.

## Fixture Rules

Fixtures should document realistic TCGdex, TCGplayer, and reference-provider behavior without leaking credentials or raw provider secrets. Live-provider tests must be opt-in; routine CI tests use deterministic fixtures or stubbed adapter clients.

## Release Verification

For issue #769 signoff, verify:

- the page test no longer owns pure profile-preview helper cases;
- provider adapter behavior can be tested without Catalog promotion/Admin concerns;
- Catalog Integration Engine behavior can be tested without live provider transport concerns;
- API and runtime tests prove focused service boundaries;
- UI section/helper tests cover guided controls close to the Admin Control Plane components they support;
- operator acceptance and E2E smoke remain anchored to full workflows without absorbing every section behavior.
