# Catalog Integration No-Confusion UX Acceptance

This note defines the no-confusion acceptance gate for the rebuilt Catalog Control Plane first slice. The gate proves operators can complete the front-and-center job: load provider source options, choose provider/unit/source scope, pull provider data, monitor import, review Source Observations, preview promotion, promote eligible sources into Catalog Items or Catalog-owned references, and verify audit/release evidence.

Health, profile authoring, validation, lifecycle recovery, RBAC, rollout controls, observability, security/privacy, provider transport, and audit work are support paths. They must explain, unblock, govern, recover, or verify import-to-promotion. They must not bury the primary path or preserve retired admin behavior as a migration target.

## Executable Gate

The executable acceptance packet lives in:

- `bounded-contexts/catalog/features/source-observations/tests/catalog-integration-no-confusion-ux-acceptance.ts`
- `bounded-contexts/catalog/features/source-observations/tests/catalog-integration-no-confusion-ux-acceptance.test.ts`

The packet uses schema `catalog-no-confusion-ux-acceptance/v1` and checklist version `catalog-no-confusion-checklist/2026-06-11`. It fails closed unless it includes:

- owner, reviewer, approval timestamp, approval reference, generated timestamp, environment, and checklist version;
- a workflow matrix for the primary path plus supporting workspaces;
- role/persona coverage for view-only operator, operator, admin, denied user, and rollout-stopped state;
- accessibility coverage for screen-reader names/descriptions, focus return, table semantics, mobile navigation semantics, disabled/denied announcements, dynamic progress updates, and keyboard completion;
- desktop and mobile visual evidence for primary states, dense tables, evidence drawers, grouped navigation, provider-transport degraded, security/privacy blocked, stale preview, and no-current-page-migration artifact states;
- resilience evidence for route load, workbench load, review API, preview API, command execution, lazy module, evidence panel, telemetry, read-model, and provider-transport failures;
- telemetry evidence, real-provider proof, durable-job edge-case evidence, the security/privacy gate, provider transport budgets, accessibility/design proof, and rollout handoff.

## Fail-Closed UX Rules

The gate rejects evidence when any workflow keeps:

- a hidden next step;
- an unexplained disabled action;
- raw JSON fallback;
- provider bypass;
- a retired migration artifact;
- overlapping text or actions;
- missing entry/completion/evidence/test coverage;
- missing section/action coverage from the primary workbench contract.

The primary workflow order is fixed for first-slice acceptance:

1. Load provider source options and choose provider, unit, and source scope from guided controls. For the TCGdex Japanese Pokemon path, select Language `Japanese`, Series `SV`, and Expansion `SV8`.
2. Sync the selected source scope through Pull provider data.
3. Monitor import.
4. Review Source Observations.
5. Preview promotion.
6. Promote all eligible observations in the selected scope to Catalog Items or Catalog-owned references.
7. Verify audit and release evidence.

## Retirement Rule

For this milestone, retire, deprecate, remove legacy, and cleanup mean complete deletion of all code, patterns, and documentation associated with retired behavior. This includes runtime/admin/test code, route handlers, API/read-model contracts, clients, feature flags, fallback branches, redirects, aliases, compatibility shims, migration shims, fixtures, seeds, screenshots, docs, runbooks, release notes, and operator instructions.

No retired behavior may remain as a hidden flag, internal support path, compatibility redirect, fallback branch, migration exception, retired fixture/test/screenshot, retained pattern, or legacy documentation. If `/catalog/integrations` remains, it must be backed only by the rebuilt workbench and clean contracts. Complete retired-surface deletion is implemented separately; this gate blocks acceptance when UX evidence still depends on retired code, tests, screenshots, docs, or patterns.

## Release Evidence

PR and release evidence for this gate should name:

- the generated no-confusion packet;
- focused test commands and CI checks;
- desktop and mobile visual evidence links;
- accessibility proof links;
- real-provider, durable-job, security/privacy, provider-transport, and telemetry proof links;
- any residual UX debt with owner issue links;
- explicit confirmation that no retired implementation, raw JSON fallback, compatibility path, support-only route, flag, alias, shim, retired fixture/test/screenshot, or legacy doc is preserved as launch behavior.

## Related References

- [Catalog Primary Workbench Admin Contract](./primary-workbench-admin-contract.md)
- [Catalog Control Plane Architecture](./catalog-control-plane-architecture.md)
- [Catalog Integration Admin UX And Accessibility Acceptance](./catalog-integration-admin-ux-accessibility.md)
- [Catalog Integration Operator Acceptance Journeys](./catalog-integration-operator-acceptance-journeys.md)
- [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md)
- [Catalog Integration Real-Provider Proof](./catalog-integration-real-provider-proof.md)
- [Catalog Integration Security Privacy Launch Gate](./catalog-integration-security-privacy-launch-gate.md), enforced by `scripts/check-structure/catalog-integration-security-privacy-launch-gate.test.mjs`
