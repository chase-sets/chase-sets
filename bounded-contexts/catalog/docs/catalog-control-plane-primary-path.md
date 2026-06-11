# Catalog Control Plane Primary Path

The rebuilt Catalog Control Plane starts with the operator job that matters most: pull provider data, review Source Observations, and promote eligible sources into Catalog Items or Catalog-owned references. Supporting workflows exist to explain, unblock, govern, recover, or verify that path. They must not bury it behind implementation-oriented modules or preserve the current two-page Catalog integrations layout as the target architecture.

This framing is the Stage 1 product contract for #1049. It complements the rebuilt route/workspace contract in [Catalog Control Plane Information Architecture](./catalog-control-plane-information-architecture.md), the first-slice sequencing in [Catalog Control Plane First-Slice Stage Board](./catalog-control-plane-first-slice-stage-board.md), and the clean-launch rules in [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md).
Operator-facing labels, blocked-state explanations, next steps, provider transport copy, resilience copy, and glossary terms are owned by [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md).

## Default Journey

The default workbench journey is:

1. Choose provider, ingestion unit, and import scope.
2. See import readiness before starting work: active profile snapshot, credential/adapter availability, fixture/readiness blockers, rollout/RBAC status, and provider transport limits.
3. Pull provider data through a durable import job.
4. Monitor queued/running/completed job progress with grouped failures, retry/resume/cancel availability, stale replay protection, and links into filtered Source Observations.
5. Review new or changed Source Observations with redacted provenance, normalized facts, diagnostics, duplicate/conflict evidence, and promotion readiness.
6. Preview promotion impact and command plan before any Catalog Item/reference writes.
7. Promote eligible observations into Catalog Items or Catalog-owned external references.
8. Resolve blocked, rejected, deferred, duplicate, conflicting, stale-preview, or partial-failure branches from the same provider/unit/scope context.
9. Reapply or replay only when a profile/mapping change requires it and the operator can see the affected promoted observations, profile mode, and job evidence.
10. Preserve audit, release, and smoke evidence automatically as the work progresses.

Operators should be able to complete the happy path without visiting profile authoring, rollout controls, RBAC, lifecycle, observability, or audit workspaces unless a blocker requires a detour.

## First Screen Requirements

The first screen of the rebuilt control plane must make the primary path obvious before secondary configuration surfaces:

- show provider/scope selection and import readiness as the top workflow;
- show Source Observation review status and promotion readiness for the selected context;
- surface active or recent import/promotion/reapply jobs that affect the selected context;
- summarize blockers with direct links to the supporting workflow that resolves them;
- keep health, profiles, validation, lifecycle, rollout, RBAC, observability, and audit as supporting entry points, not equally prominent default destinations;
- preserve provider, ingestion unit, scope, profile, filter, selection, and return-path context when moving between primary and supporting workflows.

The first screen may include compact health or readiness summaries, but those summaries must answer whether the operator can import/review/promote now. They are not a replacement for the primary workflow.

## Supporting Workflow Detours

| Supporting workflow | Why it exists | Required link-back behavior |
| --- | --- | --- |
| Health triage | Explains whether import/review/promotion is safe right now. | Link back to the affected provider/unit/scope and the blocked primary action. |
| Provider profile overview and drafting | Configures how provider facts become Source Observations and promotion command plans. | Return to the same provider/unit/scope after profile selection, draft creation, activation, or rollback. |
| Guided section editing | Fixes profile sections that block import, normalization, duplicate prevention, selected Options, references, or promotion commands. | Preserve profile version, section, diagnostic path, and the primary blocker that opened the editor. |
| Fixture validation, dry run, compare, and readiness | Proves the profile before it affects import/review/promotion. | Return to the import or promotion blocker with fixture/dry-run/compare evidence attached. |
| Adapter readiness and option queries | Explains provider transport availability and import-scope choices. | Preserve provider/unit/scope selection and show whether the primary import can proceed. |
| Lifecycle, rollback, deprecation, and retirement | Recovers or retires profile behavior that affects the primary path. | Return to affected jobs, observations, promotion previews, and profile versions. |
| RBAC, rollout controls, and observability | Governs whether primary actions are allowed, disabled, degraded, or unsafe. | Link back to denied/disabled/degraded primary actions with owner and remediation. |
| Audit and release evidence | Records who changed what and what proof ships with release/signoff. | Link back to the provider/unit/scope/job/observation/promotion evidence that generated the audit record. |

Supporting workflow labels, navigation groups, and route names should describe the operator job they solve. Avoid names that expose implementation modules as destinations when the operator is trying to finish import/review/promotion.

## Blocker Contract

Primary-path blockers must be explicit categories, not generic disabled states. A blocker shown on the primary path should include:

- blocked action: import, review, promotion preview, promotion, reapply, replay, reject, defer, retry, resume, cancel, activation, rollback, or retirement;
- affected provider, ingestion unit, scope, profile version, Source Observation filter, selected observations, or job;
- cause category: permission, rollout, credential, adapter readiness, option query, missing profile, missing fixture, validation, migration evidence, provider transport, rate limit, quota, timeout, pagination failure, stale read model, active job, promotion conflict, stale preview, idempotency/replay, security/privacy, or unavailable dependency;
- supporting workflow that resolves or explains the blocker;
- direct context-preserving link to that workflow;
- audit/evidence expectation when the operator resolves or overrides the blocker.

Unknown blocker categories must fail closed and should link to diagnostics or release evidence instead of falling back to raw JSON, legacy selectors, or the old page modules.
Visible blocker copy must use the #1058 operator-copy contract: every blocked or disabled primary-path action needs a human label, reason, next step, and supporting workflow target.

## Route And Context Rules

Route and deep-link contracts are owned by #1057, but primary-path framing requires these invariants:

- provider, ingestion unit, scope, profile version, Source Observation filters, selected row IDs, job ID, promotion preview ID, and return path are durable context keys;
- primary path links should move forward and backward through import -> review -> preview -> promote without dropping context;
- supporting workflow detours should return to the exact blocked action when possible;
- browser refresh, copied links, stale projections, denied actions, and unavailable providers must explain the current state rather than silently resetting to a generic integrations page.

## Acceptance Evidence

Stage 2 and Stage 3 implementation should cite these operator journeys from [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md):

- J08 Provider import and job diagnostics;
- J09 Source Observation provenance review;
- J10 Promote, reject, or defer observations;
- J11 Reapply mapping changes;
- J14 Audit and release evidence.

Happy-path acceptance for #1056 should prove provider/scope selection, durable import, observation review, promotion preview, and promotion can complete as one workflow in a non-production environment. Recovery acceptance should prove at least one blocked import, one blocked promotion, and one reapply/replay branch returns to the same provider/unit/scope context.

## Rejected Patterns

Do not use this framing to:

- migrate the current two-page Catalog integrations surface one-to-one;
- make health, profiles, validation, lifecycle, controls, observability, or audit equal peers that hide the primary path;
- preserve old page modules as support-only, internal, hidden, redirect-only, or migration-only destinations;
- reintroduce raw profile JSON patching, legacy provider selectors, scripted import endpoints, transitional profile mode, or silent active-profile fallback;
- describe retired behavior as usable in documentation, tests, fixtures, screenshots, runbooks, release notes, or operator instructions.

Any exception is launch-blocking until it is rebuilt as a clean launch contract or completely deleted.

## Related References

- [Catalog Control Plane First-Slice Stage Board](./catalog-control-plane-first-slice-stage-board.md)
- [Catalog Control Plane Information Architecture](./catalog-control-plane-information-architecture.md)
- [Catalog Control Plane Clean Contract Handoff](./catalog-control-plane-clean-contract-handoff.md)
- [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md)
- [Catalog Integration Control Plane](./catalog-integration-control-plane.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration No-Confusion UX Acceptance](./catalog-integration-no-confusion-ux-acceptance.md)
- [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md)
- [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md)
