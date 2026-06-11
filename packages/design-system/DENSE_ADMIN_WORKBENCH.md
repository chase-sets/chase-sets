# Dense Admin Workbench Pattern

Dense admin workbenches are for operator surfaces that need one primary workflow, supporting detours, high-density facts, and safe command surfaces in the same product area. They are not landing pages, unfocused all-in-one pages, or migrated legacy page collections.

The canonical proof artifact is `DenseAdminWorkbenchProof` from `@chase-sets/design-system`. It composes existing primitives rather than introducing a parallel admin UI layer:

- `SectionNavigation` for desktop grouped local navigation and the grouped mobile selector.
- `MetricStrip` for compact operational status facts.
- `WorkflowModule`, `WorkflowActionBar`, and `WorkflowReadinessChecklist` for cohesive workflow sections.
- `FilterArea`, `DataTable`, `BulkActionSurface`, `BulkActionBar`, and `BulkActionPanel` for dense review queues and safe selected-record commands.
- `SideSheet` for contextual evidence, diagnostics, command preview, and audit references.
- `EmptyState`, `OperationalStatusBanner`, and `Badge` for empty, degraded, blocked, denied, stale, error, and success states.

## Primary Workflow Rule

Start with the job the operator came to complete. Supporting workflows should help unblock, govern, recover, or verify that job; they should not compete with it.

For the Catalog control plane rebuild, the first and default workflow is:

1. Pull provider data.
2. Review Source Observations.
3. Preview promotion into Catalog-owned items or references.
4. Promote or recover with visible evidence.

Provider health, profile readiness, lifecycle recovery, rollout controls, audit evidence, and release verification remain grouped support workflows. They must preserve the provider, ingestion unit, scope, profile, filters, selected observations, job, promotion preview, and return path when they branch away from the primary workbench.

## Cohesive Screen Responsibilities

Use separate screens or modules when the operator intent changes:

- Primary review screen: provider pull, Source Observation queue, filters, evidence, blockers, selection, preview, and promotion.
- Unblock provider data: provider transport, scope/profile readiness, mapping blockers, and credential or policy readiness.
- Govern and recover: durable jobs, retries, kill switches, lifecycle recovery, and rollback readiness.
- Verify release evidence: audit proof, instrumentation, privacy/security review, smoke evidence, and launch signoff.

Do not rebuild a page by preserving retired product structure. A dense workbench can show many facts, but every visible region must either advance the primary import-to-promotion path or explain why that path cannot proceed.

## Mobile Translation

Desktop workbenches should keep grouped local navigation on the left when space allows. Mobile workbenches should translate those groups into the `SectionNavigation` grouped selector using `optgroup` labels. Do not flatten the menu into an ungrouped list or promote support sections above the primary workflow.

Dense tables may use `DataTable`'s stacked mobile mode for record review. Keep row identity, status, blockers, and the primary row action visible. Move deeper evidence or configuration into `SideSheet`, `BottomSheet`, or `BulkActionPanel` instead of expanding every row into a long mobile page.

## Command Safety

Every command surface must show what will happen and why it may be blocked:

- disabled row actions need accessible labels that explain the denial;
- selected-record commands belong in one `BulkActionBar`;
- advanced or risky selected-record choices belong in `BulkActionPanel` or `overflowActions`;
- evidence sheets should show redacted facts, diagnostics, command preview, and audit references;
- stale, degraded, denied, provider-transport, security, privacy, and resilience states must fail closed for unsafe commands.

`BulkActionBar` no longer supports the retired compatibility `actions` prop. Use `primaryActions`, `secondaryActions`, and `overflowActions` so action hierarchy stays explicit.

## Retirement Semantics

Retire, remove, deprecate, and cleanup mean complete removal. When an owning issue retires behavior, remove all related code, product patterns, tests, fixtures, screenshots, docs, runbooks, release notes, operator instructions, aliases, flags, fallbacks, redirects, support-only routes, and compatibility shims.

For the Catalog control plane rebuild, retired artifacts must not remain as usable routes, hidden fallbacks, support-only screens, redirects, fixtures, screenshots, docs, or operator instructions.

## Visual QA Evidence

`DenseAdminWorkbenchProof` is intentionally renderable in unit/component tests so desktop and mobile composition can be reviewed without depending on a Catalog runtime page. The proof must continue to demonstrate:

- desktop grouped navigation and mobile grouped selector;
- primary pull/review/promote actions above support workflows;
- dense table rows with long source paths, row actions, selection, denied disabled actions, loading, empty, stale, degraded, blocked, and success states;
- one canonical bulk action bar with a configuration panel;
- contextual evidence side sheets with redacted facts, diagnostics, command preview, audit references, and close behavior;
- responsive class contracts for desktop and mobile layouts.

Run the design-system tests before using the pattern downstream:

```powershell
pnpm --filter @chase-sets/design-system run test -- src/__tests__/dense-admin-workbench-proof.test.tsx
```
