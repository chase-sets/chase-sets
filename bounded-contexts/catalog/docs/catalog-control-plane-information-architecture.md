# Catalog Control Plane Information Architecture

This note is the Stage 1 IA contract for #1031. It defines how the rebuilt Catalog Control Plane is organized before #1048 and #1046 implement the grouped navigation and dense-workbench primitives.

The IA starts from the primary operator job: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting workspaces exist to unblock, govern, recover, or verify that job. They are not equal peers that bury the default workflow, and they are not a cleanup of retired admin patterns.

The authoritative TypeScript manifest is `bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/information-architecture.ts`. The grouped navigation application contract lives in [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md).

## Workspace Groups

| Group | Workspaces | Responsibility |
| --- | --- | --- |
| Primary workflow | Import to promotion workbench | Choose provider/unit/scope, confirm readiness, pull provider data, monitor jobs, review Source Observations, preview promotion, promote or recover, and preserve audit evidence. |
| Unblock provider data | Health triage, profile authoring, validation readiness, adapter readiness | Explain or resolve blockers for import, Source Observation review, promotion preview, and promotion. |
| Govern and recover | Lifecycle recovery, governance controls | Handle rollback, retirement, reapply, replay, RBAC, rollout controls, degraded states, and operational ownership. |
| Verify release evidence | Audit evidence | Trace who changed what, what proof exists, and what release/smoke/risk evidence applies. |

Desktop navigation should render these groups as left-side headings or submenu groups. Mobile navigation is owned by #1048, but it must preserve the same group order and avoid mystery tabs, horizontal scrolling, or tiny tap targets.

## Default Journey

The default route target is the Import to promotion workbench. It owns the happy path and the most common recovery branches:

1. Select provider, ingestion unit, import scope, and profile context.
2. See readiness evidence for profile, credentials, adapter, fixture/readiness, rollout/RBAC, and provider transport.
3. Start or resume a durable import job.
4. Monitor queued/running/completed/failed job state.
5. Review new or changed Source Observations with provenance, diagnostics, duplicate/conflict evidence, and promotion readiness.
6. Preview promotion command impact.
7. Promote eligible observations into Catalog Items or Catalog-owned references.
8. Recover from blocked, rejected, deferred, duplicate, conflicting, stale-preview, partial-failure, reapply, or replay branches without losing provider/unit/scope context.

Operators should not need health, profile authoring, validation, lifecycle, controls, observability, or audit screens unless a blocker requires a detour.

## Workflow Map

| Workflow | Starts in | Completes in | Required evidence |
| --- | --- | --- | --- |
| Primary import-to-promotion path | Import to promotion workbench | Import to promotion workbench | Import readiness, job progress, Source Observation review, promotion preview. |
| Health triage | Health triage | Import to promotion workbench | Readiness KPIs, read-model freshness, semantic readiness, fixture/dry-run status, transport readiness, rollout stops, active jobs, and audit preview. |
| Profile overview, drafting, and section editing | Profile authoring | Import to promotion workbench | Selected profile overview, lifecycle restrictions, immutable clone facts, validation, fixture coverage, authoring audit, draft outcome, and section diagnostics. |
| Validation, dry run, compare, and activation readiness | Validation readiness | Import to promotion workbench | Fixture result, dry-run evidence, semantic compare, activation readiness. |
| Imports, jobs, Source Observation review, promotion, reapply, replay | Import to promotion workbench | Import to promotion workbench | Durable job state, observation evidence, promotion command plan, recovery result. |
| Lifecycle, rollout, RBAC, observability, and audit evidence | Governance controls | Audit evidence | Permission result, rollout mode, operational metric, audit record. |

Every detour must include a context-preserving return link. Required durable context keys are provider key, ingestion unit key, import scope, profile version, Source Observation filters, selected observation IDs, job ID, promotion preview ID, and return path where applicable.

## Route And Screen Boundaries

The rebuilt control plane has one primary admin entry point backed by the Import to promotion workbench. Supporting workspaces are screen-level detours inside that rebuilt experience, and each detour must preserve return context to the primary job.

Launch screen boundaries:

- Import setup, durable job progress, Source Observation review, promotion preview, promotion execution, and common recovery branches stay in the primary workbench.
- Health triage is the dense support dashboard for distinguishing Catalog semantic readiness from provider adapter transport, rollout stops, active jobs, operational owner metrics, and audit projection state. It must keep a context-preserving return to the import-to-promotion workbench and must not become a second default page.
- Profile authoring owns provider profile overview, draft creation, lifecycle restrictions, immutable identity evidence, and later typed section editing. It stays a detour only when profile evidence blocks or supports the primary provider-data pull and promotion path.
- Validation readiness, adapter readiness, lifecycle recovery, governance controls, and audit evidence are detours only when they unblock, govern, recover, or verify the primary job.
- No screen may recreate retired admin patterns, tabbed module splits, raw JSON fallbacks, provider-specific UI branches, or compatibility paths.

Retire, remove, deprecate, and cleanup mean complete deletion of retired code, product patterns, routes, APIs, read-model contracts, clients, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions. No hidden flag, feature flag, fallback branch, compatibility redirect, alias, shim, migration shim, or support-only route may preserve a retired screen or pattern.

## Test Contract

The IA manifest is covered by `information-architecture.test.ts`. The tests prove:

- Import to promotion is the first navigation target and only default workspace.
- Navigation groups have stable accessible names and keyboard traversal order.
- Every supporting workspace preserves return context to the primary path.
- #1031 workflow coverage exists without making support workflows equal peers.
- Release rules prove one rebuilt primary workbench, context-preserving support detours, and complete removal of retired artifacts.

## Downstream Use

- #1048 implements grouped section navigation/submenus and the mobile translation against this group order, using [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md) and the design-system [Section Navigation](../../../packages/design-system/SECTION_NAVIGATION.md) pattern.
- #1046 implements dense-workbench primitives that can render the workspace responsibilities and evidence states.
- #1057 owns route, deep-link, and context preservation details.
- #1056 owns the cohesive default import-to-promotion workbench.
- #1090 owns complete deletion of retired admin pages, supporting artifacts, route/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions after the rebuilt first slice is accepted.

## Related References

- [Catalog Control Plane Primary Path](./catalog-control-plane-primary-path.md)
- [Catalog Control Plane Section Navigation](./catalog-control-plane-section-navigation.md)
- [Catalog Control Plane First-Slice Stage Board](./catalog-control-plane-first-slice-stage-board.md)
- [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
