# Catalog Control Plane Information Architecture

This note is the Stage 1 IA contract for #1031. It defines how the rebuilt Catalog Control Plane is organized before #1048 and #1046 implement the grouped navigation and dense-workbench primitives.

The IA starts from the primary operator job: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting workspaces exist to unblock, govern, recover, or verify that job. They are not equal peers that bury the default workflow, and they are not a one-to-one migration of the current `/catalog/integrations` and `/catalog/source-observations` pages.

The authoritative TypeScript manifest is `bounded-contexts/catalog/features/source-observations/ui/admin-control-plane/information-architecture.ts`.

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
| Health triage | Health triage | Import to promotion workbench | Read-model freshness, semantic readiness, transport readiness. |
| Profile overview, drafting, and section editing | Profile authoring | Import to promotion workbench | Profile version, section diagnostics, save outcome. |
| Validation, dry run, compare, and activation readiness | Validation readiness | Import to promotion workbench | Fixture result, dry-run evidence, semantic compare, activation readiness. |
| Imports, jobs, Source Observation review, promotion, reapply, replay | Import to promotion workbench | Import to promotion workbench | Durable job state, observation evidence, promotion command plan, recovery result. |
| Lifecycle, rollout, RBAC, observability, and audit evidence | Governance controls | Audit evidence | Permission result, rollout mode, operational metric, audit record. |

Every detour must include a context-preserving return link. Required durable context keys are provider key, ingestion unit key, import scope, profile version, Source Observation filters, selected observation IDs, job ID, promotion preview ID, and return path where applicable.

## Route And Screen Boundaries

The rebuilt control plane may retain familiar URLs only when those URLs are backed by rebuilt contracts:

| Current concept | Disposition | Target |
| --- | --- | --- |
| `/catalog/integrations` two-page god page | Rebuild as clean contract | Import to promotion workbench. The URL may remain, but old page code, module structure, tests, fixtures, screenshots, docs, and runbooks must be deleted. |
| `/catalog/source-observations` list/import page | Rebuild as clean contract | Import to promotion workbench or a focused Source Observation review deep link. The old second-page workflow must not remain. |
| Health, authoring, validation, operations, and audit segmented modules | Delete | Do not migrate these areas into grouped navigation one-to-one. |
| Import and job operations module | Fold into primary path | Import and job state are steps in the default workbench. |
| Source Observation review workflow module | Fold into primary path | Review stays connected to import scope and promotion preview. |
| Promote and reapply workflow module | Fold into primary path | Promotion preview and recovery stay connected to the primary path. |
| Provider profile review module | Supporting detour | Profile authoring exists to unblock import/review/promotion and must preserve return context. |
| Rollback and retirement module | Supporting detour | Lifecycle actions are rebuilt around impact evidence and complete removal semantics. |

Retire, remove, deprecate, and cleanup mean complete deletion of old code, patterns, tests, fixtures, screenshots, docs, runbooks, release notes, and operator instructions. No hidden flag, fallback branch, compatibility redirect, alias, shim, or support-only route may preserve a retired screen or pattern.

## Test Contract

The IA manifest is covered by `information-architecture.test.ts`. The tests prove:

- Import to promotion is the first navigation target and only default workspace.
- Navigation groups have stable accessible names and keyboard traversal order.
- Every supporting workspace preserves return context to the primary path.
- #1031 workflow coverage exists without making support workflows equal peers.
- Current two-page/god-page module concepts are deleted, rebuilt, or folded into the primary path rather than migrated one-to-one.

## Downstream Use

- #1048 implements grouped section navigation/submenus and the mobile translation against this group order.
- #1046 implements dense-workbench primitives that can render the workspace responsibilities and evidence states.
- #1057 owns route, deep-link, and context preservation details.
- #1056 owns the cohesive default import-to-promotion workbench.
- #1090 owns complete deletion of the current pages and old supporting artifacts after the rebuilt first slice is accepted.

## Related References

- [Catalog Control Plane Primary Path](./catalog-control-plane-primary-path.md)
- [Catalog Control Plane First-Slice Stage Board](./catalog-control-plane-first-slice-stage-board.md)
- [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
