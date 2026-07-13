# Catalog Control Plane Architecture

This note is the Stage 1 architecture contract for the rebuilt Catalog Control Plane. It defines the operator primary path, the workspace information architecture, and the concrete admin route map before the grouped navigation and dense-workbench primitives are implemented.

The control plane starts from the operator job that matters most: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting workspaces exist to explain, unblock, govern, recover, or verify that path. They are not equal peers that bury the default workflow, and they are not a cleanup of retired admin patterns. They must not preserve retired admin structure as the target architecture.

The authoritative TypeScript manifest is `bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/information-architecture.ts`. The grouped navigation application contract lives in [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md). Operator-facing labels, blocked-state explanations, next steps, provider transport copy, resilience copy, and glossary terms are owned by [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md).

## Operator primary path

The default route target is the Import to promotion workbench. It owns the happy path and the most common recovery branches. The default workbench journey is:

1. Choose provider, ingestion unit, and source scope (plus profile context) from synced provider options. For the TCGdex Japanese Pokemon path, select Language `Japanese`, Series `SV`, and Expansion `SV8`; operators should not type a serialized scope by hand.
2. See import readiness before starting work: active profile snapshot, credential/adapter availability, fixture/readiness blockers, rollout/RBAC status, and provider transport limits.
3. Select the source scope, then pull provider data through a durable import job for that exact scope.
4. Monitor queued/running/completed/failed job progress with grouped failures, retry/resume/cancel availability, stale replay protection, and links into filtered Source Observations.
5. Review new or changed Source Observations with redacted provenance, normalized facts, diagnostics, duplicate/conflict evidence, and promotion readiness.
6. Preview promotion impact and command plan before any Catalog Item/reference writes.
7. Promote eligible observations into Catalog Items or Catalog-owned external references.
8. Resolve blocked, rejected, deferred, duplicate, conflicting, stale-preview, or partial-failure branches from the same provider/unit/scope context.
9. Reapply or replay only when a profile/mapping change requires it and the operator can see the affected promoted observations, profile mode, and job evidence.
10. Preserve audit, release, and smoke evidence automatically as the work progresses.

Operators should be able to complete the happy path without visiting profile authoring, rollout controls, RBAC, lifecycle, observability, or audit workspaces unless a blocker requires a detour.

### First screen requirements

The first screen of the rebuilt control plane must make the primary path obvious before secondary configuration surfaces:

- show provider/scope selection and import readiness as the top workflow;
- load provider source options into guided selectors before asking the operator to start a sync;
- show Source Observation review status and promotion readiness for the selected context;
- surface active or recent import/promotion/reapply jobs that affect the selected context;
- summarize blockers with direct links to the supporting workflow that resolves them;
- keep health, profiles, validation, lifecycle, rollout, RBAC, observability, and audit as supporting entry points, not equally prominent default destinations;
- preserve provider, ingestion unit, scope, profile, filter, selection, and return-path context when moving between primary and supporting workflows.

The first screen may include compact health or readiness summaries, but those summaries must answer whether the operator can import/review/promote now. They are not a replacement for the primary workflow.

### Blocker contract

Primary-path blockers must be explicit categories, not generic disabled states. A blocker shown on the primary path should include:

- blocked action: import, review, promotion preview, promotion, reapply, replay, reject, defer, retry, resume, cancel, activation, rollback, or retirement;
- affected provider, ingestion unit, scope, profile version, Source Observation filter, selected observations, or job;
- cause category: permission, rollout, credential, adapter readiness, option query, missing profile, missing fixture, validation, migration evidence, provider transport, rate limit, quota, timeout, pagination failure, stale read model, active job, promotion conflict, stale preview, idempotency/replay, security/privacy, or unavailable dependency;
- supporting workflow that resolves or explains the blocker;
- direct context-preserving link to that workflow;
- audit/evidence expectation when the operator resolves or overrides the blocker.

Unknown blocker categories must fail closed and should link to diagnostics or release evidence instead of falling back to raw JSON, legacy selectors, or the old page modules. Visible blocker copy must use the [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md) contract: every blocked or disabled primary-path action needs a human label, reason, next step, and supporting workflow target.

## Information architecture

Supporting workspaces are organized into four groups around the primary job. Desktop navigation should render these groups as left-side headings or submenu groups. Mobile navigation must preserve the same group order and avoid mystery tabs, horizontal scrolling, or tiny tap targets.

| Group | Workspaces | Responsibility |
| --- | --- | --- |
| Primary workflow | Import to promotion workbench | Choose provider/unit/scope, confirm readiness, pull provider data, monitor jobs, review Source Observations, preview promotion, promote or recover, and preserve audit evidence. |
| Unblock provider data | Health triage, profile authoring, validation readiness, adapter readiness | Explain or resolve blockers for import, Source Observation review, promotion preview, and promotion. |
| Govern and recover | Lifecycle recovery, governance controls | Handle rollback, retirement, reapply, replay, RBAC, rollout controls, degraded states, and operational ownership. |
| Verify release evidence | Audit evidence | Trace who changed what, what proof exists, and what release/smoke/risk evidence applies. |

### Workflow map

Each workflow has a defined start, completion surface, and required evidence. Every detour must include a context-preserving return link.

| Workflow | Starts in | Completes in | Required evidence |
| --- | --- | --- | --- |
| Primary import-to-promotion path | Import to promotion workbench | Import to promotion workbench | Import readiness, job progress, Source Observation review, promotion preview. |
| Health triage | Health triage | Import to promotion workbench | Readiness KPIs, read-model freshness, semantic readiness, fixture/dry-run status, transport readiness, rollout stops, active jobs, and audit preview. |
| Profile overview, drafting, and section editing | Profile authoring | Import to promotion workbench | Selected profile overview, lifecycle restrictions, immutable clone facts, validation, fixture coverage, authoring audit, draft outcome, and section diagnostics. |
| Validation, dry run, compare, and activation readiness | Validation readiness | Import to promotion workbench | Fixture result, dry-run evidence, semantic compare, activation readiness. |
| Imports, jobs, Source Observation review, promotion, reapply, replay | Import to promotion workbench | Import to promotion workbench | Durable job state, observation evidence, promotion command plan, recovery result. |
| Lifecycle, rollout, RBAC, observability, and audit evidence | Governance controls | Audit evidence | Permission result, rollout mode, operational metric, audit record. |

### Supporting workflow detours

Each supporting workflow exists for a specific operator job and must link back to the blocked primary action with context preserved. Supporting workflow labels, navigation groups, and route names should describe the operator job they solve. Avoid names that expose implementation modules as destinations when the operator is trying to finish import/review/promotion.

| Supporting workflow | Why it exists | Required link-back behavior |
| --- | --- | --- |
| Health triage | Explains whether import/review/promotion is safe right now. | Link back to the affected provider/unit/scope and the blocked primary action. |
| Provider profile overview and drafting | Configures how provider facts become Source Observations and promotion command plans. | Return to the same provider/unit/scope after profile selection, draft creation, activation, or rollback. |
| Guided section editing | Fixes profile sections that block import, normalization, duplicate prevention, selected Options, references, or promotion commands. | Preserve profile version, section, diagnostic path, and the primary blocker that opened the editor. |
| Fixture validation, dry run, compare, and readiness | Proves the profile before it affects import/review/promotion. | Return to the import or promotion blocker with fixture/dry-run/compare evidence attached. |
| Adapter readiness and option queries | Explains provider transport availability and import-scope choices. | Preserve provider/unit/scope selection and show whether the primary import can proceed. |
| Lifecycle, rollback, deprecation, and retirement | Recovers or retires profile behavior that affects the primary path. | Return to affected jobs, observations, promotion previews, and profile versions. |
| RBAC, rollout controls, and observability | Governs whether primary actions are allowed, disabled, degraded, or unsafe. | Link back to denied/disabled/degraded primary actions with owner and remediation. |
| Audit and release evidence | Records who changed what and what proof ships with release approval. | Link back to the provider/unit/scope/job/observation/promotion evidence that generated the audit record. |

## Route map

This deprecated `?section=`-carrying IA is being retired workspace-by-workspace as the m90 v2 blueprint's implementation slices land (see `catalog-control-plane-blueprint-v2.md` and `information-architecture-v2.ts`). #3832 retired the **providers** surface: profile authoring, validation readiness, and the profile lifecycle (rollback/deprecate/retire, formerly on governance) are now one v2 page, `/catalog/providers/:providerKey` (`features/source-observations/ui/admin-control-plane/provider-detail/`), reached by path param rather than `?section=` and carrying no `returnPath`. The remaining three real nested routes under `/admin/integrations` are still built from the shared workbench shell described below; there is still no `?section=` mini-app on them.

| Route | Surface | Workspaces (in render order) | Loader entry point |
| --- | --- | --- | --- |
| `/admin/integrations` | daily | import-to-promotion | `support/route-support/admin-integrations/integrations-loader.ts` |
| `/admin/integrations/governance` | governance | conflict-resolution, governance-controls | `support/route-support/admin-integrations/governance-loader.ts` |
| `/admin/integrations/health` | health | audit-evidence, health-triage | `support/route-support/admin-integrations/health-loader.ts` |
| `/catalog/providers/:providerKey` | — (v2 page, not a workspace-router surface) | profile authoring + validation readiness + profile lifecycle + credential/transport health, all inline | `support/route-support/admin-integrations/provider-detail-loader.ts` |

The daily route is the default and renders only the primary import-to-promotion job. Governance and health render their grouped supporting workspaces stacked. The health surface is the **Integration Health** route: it answers "is import, review, or promotion safe right now?" through health triage, and traces who changed what through the audit timeline.

### Source of truth

- The surfaces, their path segments, and their workspaces are declared in `features/source-observations/ui/admin-control-plane/information-architecture.ts` as `CATALOG_CONTROL_PLANE_ROUTE_SURFACES`. Each workspace also carries a `routeSurface` field, and the IA↔render parity test (`information-architecture.test.ts`) asserts that every workspace belongs to exactly one surface and that every surface workspace is renderable.
- The routes are registered as thin composition roots in the catalog deployable contribution (`context.json`, `deployableContributions[].routes`) with route IDs `integrations`, `integrations-governance`, `integrations-health`, and `provider-detail` (the v2 page, `providers/:providerKey`). The admin-web deployable resolves them through the established `resolveWebHostRouteConfigRecords` → `toRouteConfigEntry` framework (React Router v7), the same path each sibling catalog admin route uses.
- The route files (`routes/admin/integrations*.tsx`) are thin roots: they re-export the loader/action and render `CatalogIntegrationsSurfaceRouteView` with their surface key. The shared shell lives in `features/source-observations/ui/workbench-shell.tsx`; the surface body composition lives in `integrations-surface-page.tsx`; the render registry lives in `workbench-workspace-renderers.tsx`.

### Section state vs route path

The route path is the screen router. The `section` query param (and the `routeContext.section`) only identifies the precise workspace within a multi-workspace surface, which drives active-nav highlighting and detour telemetry. It is never the screen router.

- A direct visit to `/admin/integrations/providers` opens the surface default workspace (profile authoring) with no query state.
- The action's redirects still set the precise workspace; the shared href helper resolves that workspace to its surface route, so a profile save redirects to `/admin/integrations/providers` and an activation to `/admin/integrations/providers?section=readiness`.

### Return context across routes

Every supporting detour deep-links to the surface route that hosts its workspace and carries a `returnPath` query param that points back to the daily import-to-promotion route, plus the working-set context keys: provider key, ingestion unit key, import scope, profile version, Source Observation filters, selected observation IDs, job ID, and promotion preview ID. These are the durable context keys; primary-path links should move forward and backward through import → review → preview → promote without dropping context, and supporting detours should return to the exact blocked action when possible. Because each surface is a real route, browser back/forward and bookmarks preserve context with no `pushState` section router. Browser refresh, copied links, stale projections, denied actions, and unavailable providers must explain the current state rather than silently resetting to a generic integrations page. The route-context href helpers and the `returnPath` round-trip are covered by `primary-workbench-route-context.test.ts`.

### Single canonical router

The four nested routes are the only canonical router. There is no compatibility shim, alias, hidden flag, or fallback branch for an in-page top-level section switcher. The IA parity guard in `information-architecture.test.ts` fails closed if a retired section key, route segment, renderer key, or nav item reappears.

No screen may recreate retired admin patterns, tabbed module splits, raw JSON fallbacks, provider-specific UI branches, or compatibility paths. Retire, remove, deprecate, and cleanup mean complete deletion of retired code, product patterns, routes, APIs, read-model contracts, clients, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions. No hidden flag, feature flag, fallback branch, compatibility redirect, alias, shim, migration shim, or support-only route may preserve a retired screen or pattern.

### Rejected patterns

Do not use this architecture to:

- migrate retired admin structure one-to-one;
- make health, profiles, validation, lifecycle, controls, observability, or audit equal peers that hide the primary path;
- preserve retired modules as support-only, internal, hidden, redirect-only, or migration-only destinations;
- reintroduce raw profile JSON patching, legacy provider selectors, scripted import endpoints, transitional profile mode, or silent active-profile fallback;
- describe retired behavior as usable in documentation, tests, fixtures, screenshots, runbooks, release notes, or operator instructions.

Any exception is launch-blocking until it is rebuilt as a clean launch contract or completely deleted.

## Test contract

The IA manifest is covered by `information-architecture.test.ts`. The tests prove:

- Import to promotion is the first navigation target and only default workspace.
- Navigation groups have stable accessible names and keyboard traversal order.
- Every supporting workspace preserves return context to the primary path.
- Workflow coverage exists without making support workflows equal peers.
- Release rules prove one rebuilt primary workbench, context-preserving support detours, and complete removal of retired artifacts.

## Acceptance evidence

Stage 2 and Stage 3 implementation should cite these operator journeys from [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md):

- J08 Provider import and job diagnostics;
- J09 Source Observation provenance review;
- J10 Promote, reject, or defer observations;
- J11 Reapply mapping changes;
- J14 Audit and release evidence.

Happy-path acceptance for the primary workbench should prove provider source option loading, TCGdex Japanese SV8 source-scope selection, durable import, observed Source Observation review, promotion preview, and promote-all execution can complete as one workflow in a non-production environment. Recovery acceptance should prove at least one blocked import, one blocked promotion, and one reapply/replay branch returns to the same provider/unit/scope context.

## Downstream use

- Grouped section navigation/submenus and the mobile translation are implemented against this group order, using [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md) and the design-system [Section Navigation](../../../packages/design-system/SECTION_NAVIGATION.md) pattern.
- Dense-workbench primitives render the workspace responsibilities and evidence states.
- Route, deep-link, and context preservation details build on this architecture.
- The cohesive default import-to-promotion workbench is assembled from these workspace groups.
- Complete deletion of retired admin pages, supporting artifacts, route/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions follows once the rebuilt first slice is accepted.

## Related references

- [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md)
- [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration No-Confusion UX Acceptance](./catalog-integration-no-confusion-ux-acceptance.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
