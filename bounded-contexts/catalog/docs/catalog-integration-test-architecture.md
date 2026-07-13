# Catalog Integration Test Architecture

Catalog Integration Control Plane tests should prove the decomposed boundaries directly through rebuilt contracts. Launch acceptance must use rebuilt primary workbench contracts, rebuilt UI modules, route/API/read-model tests, and no-confusion evidence.

## Boundary Map

| Boundary | Owner | Primary Coverage |
| --- | --- | --- |
| Provider transport adapters | Provider adapter code | `features/source-observations/api/provider-adapters/provider-adapter.test.ts` |
| Catalog Integration Engine semantics | Catalog Source Observations | `features/source-observations/api/catalog-integration-engine.test.ts` |
| Provider profile contracts and section parsing | Catalog Source Observations | `features/source-observations/api/provider-profile-contract-harness.test.ts`, `provider-profile-admin-contracts.test.ts`, `provider-profile-section-registry.test.ts`, `provider-profile-section-projection.test.ts` |
| Runtime facets and jobs | Catalog Source Observations | `features/source-observations/api/runtime-service-facets.test.ts`, `runtime.test.ts` |
| API permissions, validation, rollout, and streams | Catalog Source Observations API | `features/source-observations/api/route-integration-jobs.test.ts`, `route-provider-profile-admin.test.ts`, `route-review-controls.test.ts` |
| Admin Control Plane workbench read model | Catalog Source Observations UI | `features/source-observations/ui/primary-workbench-core-read-model.test.ts`, `primary-workbench-profile-authoring.test.ts`, `primary-workbench-validation-readiness.test.ts`, `primary-workbench-lifecycle-recovery.test.ts`, `primary-workbench-import-jobs.test.ts`, `primary-workbench-health-triage.test.ts`, `primary-workbench-source-observation-review.test.ts`, `primary-workbench-conflict-resolution.test.ts`, `primary-workbench-governance-controls.test.ts`, `primary-workbench-audit-evidence.test.ts` |
| Admin Control Plane rendered workflows | Catalog Source Observations UI | `features/source-observations/ui/primary-workbench-page.test.tsx` |
| Admin Control Plane route context and copy | Catalog Source Observations UI | `features/source-observations/ui/primary-workbench-route-context.test.ts`, `primary-workbench-copy.test.ts` |
| Admin integrations route loader seams | Catalog Source Observations UI | `tests/admin-integrations-route-loader-core.test.tsx`, `admin-integrations-route-loader-operator.test.tsx`, `admin-integrations-route-loader-provider-units.test.tsx`, `admin-integrations-route-loader-source-options.test.tsx` |
| Admin integrations route actions and governance | Catalog Source Observations UI | `tests/admin-integrations-route-action.test.tsx`, `admin-integrations-route-governance.test.tsx` |
| Admin integrations route rendering | Catalog Source Observations UI | `tests/admin-integrations-route-render.test.tsx` |
| Operator journeys and no-confusion acceptance | Catalog acceptance and deployable E2E | `tests/operator-acceptance-journeys.test.ts`, `features/source-observations/tests/catalog-integration-no-confusion-ux-acceptance.test.ts` |

## Rules

- Provider adapter tests may assert auth/session state, option transport, pagination, rate-limit diagnostics, typed payload acquisition, and provenance. They must not assert Catalog promotion, replay, duplicate-prevention, or Admin page behavior.
- Catalog Integration Engine tests may assert Source Observation facts, diagnostics, profile interpretation, duplicate-prevention evidence, dry-run output, conflict policy, and promotion/reapply primitives. They must not depend on live provider transport.
- API route tests may assert request validation, permissions, fail-closed launch gates, rollout evidence, job event streams, and service delegation. They should use stubbed services rather than provider network calls.
- Runtime facet tests may prove the aggregate runtime still exposes focused service contracts for provider adapters, imports, provider options, profile admin, engine readiness, review, promotion/reapply, bulk review jobs, integration jobs, and reads.
- Primary workbench read-model seam tests, copy tests, and route-context tests own provider option summaries, external references, reference hierarchy, duplicate prevention, promotion command plans, route context, and operator copy.
- Rebuilt page tests own rendered operator workflows, dialog state, permissions, lifecycle actions, job progress, dense tables, evidence drawers, and grouped navigation. They should not be the default home for pure profile-section helper behavior.
- E2E tests cover representative happy paths and critical blocked states for the rebuilt import-to-promotion journey. They do not own every section editor behavior.

## Fixture Rules

Fixtures should document realistic TCGdex, TCGplayer, and reference-provider behavior without leaking credentials or raw provider secrets. Live-provider tests must be opt-in; routine CI tests use deterministic fixtures or stubbed adapter clients.

## Release Verification

For release approval, verify:

- retired implementation artifacts are not accepted as launch evidence;
- provider adapter behavior can be tested without Catalog promotion/Admin concerns;
- Catalog Integration Engine behavior can be tested without live provider transport concerns;
- API and runtime tests prove focused service boundaries;
- UI section/helper tests cover guided controls close to the Admin Control Plane components they support;
- operator acceptance, no-confusion evidence, and E2E smoke remain anchored to full rebuilt workflows without absorbing every section behavior.

Retire, deprecate, remove legacy, and cleanup mean complete deletion of associated code, patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions. No hidden flag, fallback, compatibility redirect, support-only path, alias, shim, retired fixture/test/screenshot, or legacy documentation can preserve retired behavior.
