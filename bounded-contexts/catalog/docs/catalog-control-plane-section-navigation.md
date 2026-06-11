# Catalog Control Plane Section Navigation

This note is the Catalog-specific application contract for #1048. It applies the design-system [Section Navigation](../../../packages/design-system/SECTION_NAVIGATION.md) pattern to the rebuilt Catalog Control Plane.

## Product Priority

The first and default operator job is:

1. pull provider data;
2. review Source Observations;
3. promote eligible sources into Catalog Items or Catalog-owned references.

Every other screen exists to unblock, govern, recover, or verify that job. Navigation, labels, counts, and empty states must reinforce that hierarchy.

## Group Contract

| Group | First responsibility | Screen responsibility |
| --- | --- | --- |
| Primary workflow | Import to promotion workbench | Choose provider/unit/scope, confirm readiness, pull provider data, monitor jobs, review observations, preview promotion, promote, and recover common branches without leaving the workflow. |
| Unblock provider data | Health triage | Resolve provider/profile/adapter/validation blockers only when they prevent import, review, or promotion. |
| Govern and recover | Lifecycle recovery | Roll back, reapply, replay, retire, and govern risky operations with impact evidence and return context. |
| Verify release evidence | Audit evidence | Trace operator actions, release proof, smoke evidence, and risk decisions. |

The primary workflow group must render first on desktop and first in the mobile grouped selector. The default route target must be the Import to promotion workbench.

## Screen Boundaries

The rebuild must not migrate the current `/catalog/integrations` and `/catalog/source-observations` pages as two cleaned-up pages. It must create cohesive screens around jobs:

- Import to promotion workbench owns import setup, job progress, Source Observation review, promotion preview, promotion, and common recovery branches.
- Health triage owns stale read models, provider transport failures, semantic readiness gaps, and related return links.
- Profile authoring owns draft/edit/review of provider profile sections only when needed to unblock the primary path.
- Validation readiness owns fixture results, dry-run evidence, semantic compare, and activation readiness.
- Governance controls owns rollout, RBAC, dangerous operation confirmation, and degraded-state controls.
- Audit evidence owns history and proof. It does not become a general operations dashboard.

Each screen must have one cohesive job. A screen that needs several unrelated headings, tab sets, or action clusters is a decomposition failure and should be split before implementation.

## Desktop And Mobile

Desktop must use left-side grouped section navigation with headings that match the group contract. Active, blocked, disabled, warning, pending, and count states should make the next operator decision visible without replacing the screen's own readiness evidence.

Mobile must use the same groups in the same order through the approved grouped selector. Do not translate the control plane to horizontal tabs, tiny sidebars, icon-only rail menus, or a generic menu that hides the primary import-to-promotion path.

## Context Preservation

Every supporting detour must preserve enough context to return to the primary path without making the operator re-create their working set. Required context keys are:

- provider key;
- ingestion unit key;
- import scope;
- profile version;
- Source Observation filters;
- selected Source Observation IDs;
- job ID;
- promotion preview ID;
- return path.

The return target should be the Import to promotion workbench unless the operator intentionally entered a verification-only screen.

## Retirement Contract

Retire, remove, deprecate, and cleanup mean complete deletion of the old catalog control-plane code, product patterns, routes, APIs, read-model contracts, clients, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions.

Do not keep:

- hidden feature flags or fallback branches;
- compatibility redirects to the old two-page model;
- aliases, compatibility shims, or migration shims for old module names;
- support-only routes that still render retired surfaces;
- documentation that tells operators how to use retired screens;
- tests or fixtures that preserve old raw JSON or provider-specific UI branches.

The product has not launched, so preserving legacy data or interaction patterns is not a requirement. Data loss is acceptable when it removes pre-launch legacy state and simplifies the launch contract.

## Acceptance Checks

- The first visible desktop group and first mobile group are `Primary workflow`.
- The first item is Import to promotion.
- Pull provider data, review Source Observations, and promote are reachable without detouring through support screens.
- Supporting screens include context-preserving return behavior.
- No screen maps one-to-one to the old god page modules.
- No retired code, product patterns, route/API/client/read-model behavior, documentation, tests, fixtures, seeds, screenshots, runbooks, release notes, or operator instructions remain.
- No raw JSON fallback or provider-specific Catalog UI branch survives the rebuild.
