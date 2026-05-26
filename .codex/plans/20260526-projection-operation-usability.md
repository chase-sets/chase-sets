# Projection Operation Usability

## Intent

Redesign the Projection Operations admin surface so an operator can answer, in order:

1. Is the projection system healthy right now?
2. What needs attention first?
3. Which operation, projection group, subscription, stream, or worker explains the issue?
4. What is the safest next action?
5. Did the action get queued, claimed, completed, cancelled, or fail?

The work should turn the current dense status dump into an operational console: summary first, failure-first triage, progressive drilldown, durable operation history, and accessible controls. It should keep the projection runtime event-driven and consumer-owned while moving operator UI and workflow code out of deployable ownership.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-projection-operation-usability`
- Branch: `codex/projection-operation-usability`
- Base: `origin/main` at `bf4db7e6` (`Harden projection operations and rebuilds (#288)`)
- Sandbox id: `ae1ca73d`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default embedded worktree store, `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup notes: local admin-web dev starts with a scoped process override `NOTIFICATION_EMAIL_PROVIDER=noop`; the default worker port `6463` was occupied locally, so browser verification used `CHASE_SETS_SANDBOX_BASE_PORT=7100`.
- Product/runtime edits during planning: none; implementation edits started after goal continuation

## Owning Contexts

- New recommended context: `platform-operations`.
  - Owns platform operator workflows, route modules, UI state, API clients, operation-console language, tests, and runbook-facing terminology for cross-context runtime operations.
  - Initial slice: `projection-operations`.
  - Future slices may include worker operations, event backlog, deployment/runtime health, or job queue operations if they become first-class operator workflows.
- `infrastructure/platform-runtime` remains the shared technical owner of the projection operations API factory, control-plane queue access, worker status, runner status, and lease/fencing primitives.
- `infrastructure/bounded-context-runtime` remains the shared technical owner of generic projection group status, subscription status, replay, rebuild, and stream repair behavior.
- Individual bounded contexts remain the owners of projection declarations, projection groups, projection handlers, read models, reset strategies, and context-specific correctness.
- `deployables/admin-web`, `deployables/platform-api`, `deployables/admin-support-api`, and worker deployables stay thin composition roots.

This supersedes the older implementation-plan assumption in `.codex/plans/20260525-projection-operations.md` that `admin-web` could own the operator UI because the page was cross-context. The current repo instruction and architecture direction are stricter: bounded contexts own UI and tests; deployables compose.

## Repo Evidence

- `bounded-contexts/README.md` says each bounded context owns its terms, state transitions, read models, UI, and tests, and cross-context interaction must use stable IDs and published facts.
- `docs/architecture/bounded-context-structure.md` says deployables are thin composition roots and bounded contexts own route modules and shell contributions.
- `docs/architecture/event-projections.md` says operator-triggered rebuild, retry, and replay are durable projection operations; publishers remain unaware of projectors.
- `docs/architecture/event-projection-operations.md` defines queued, running, cancel-requested, succeeded, failed, and cancelled operation lifecycle states plus lease/fencing rules.
- `docs/architecture/event-projection-runtime.md` defines operator states: `caught-up`, `behind`, `running`, `degraded`, `error`, and `idle`.
- `docs/runbooks/projection-operations.md` says the summary endpoint should be cheap during incidents, blocked stream details should load only when needed, and operation summaries expose queued, running, failed, cancel-requested, oldest queued/running, and average duration.
- `deployables/admin-web/app/routes/projection-operations.tsx` currently contains all route data normalization, page layout, operation forms, tables, and helper formatting in one deployable route.
- `deployables/admin-web/app/routes.ts` mounts `/operations/projections` directly instead of through a bounded-context route contribution.
- `infrastructure/platform-runtime/projection-operations-routes.ts` already exposes detail endpoints, operation filters, operation detail, and cancellation API support that the current UI does not fully use.
- `packages/design-system/src/components/data-display/data-table.tsx` has compact density, selection, sorting, loading, and mobile modes, but no sticky header, pagination, row click, column visibility, virtualization, or detail-drawer affordance.
- `packages/design-system` already has `FilterArea`, `AppliedFilterChips`, `BulkActionBar`, `BulkActionPanel`, `Tabs`, `DataTable`, `Badge`, `StatGrid`, and `DetailPanel` patterns that should be reused instead of custom page-local controls.

## Resolved Decisions

- Create a `platform-operations` bounded context rather than further expanding deployable-owned admin routes. This gives the workflow a canonical home without pretending projection health belongs to Catalog, Identity, Support, or Insights.
- Keep generic projection operation execution in shared infrastructure. The new context owns operator experience and client contracts, not projection repair semantics.
- Make the first viewport a triage dashboard, not a table. Lead with status, attention counts, live/stale data freshness, oldest queued/running operation, failed/cancel-requested operations, source/applicable lag, active/stale workers, blocked streams, poison events, stale revisions, and last updated.
- Make failures first-class. A default attention lane should show failed operations, cancel-requested operations, degraded/error projections, blocked streams, poison events, stale snapshots, stale workers, and stale revisions before routine caught-up rows.
- Use progressive disclosure. The operator starts in `Overview`, drills into `Operations`, `Projection Groups`, `Subscriptions`, `Blocked Streams`, `Workers`, or `Diagnostics`, then opens a details panel for one selected record.
- Use route-level query state for filters and selected tab where possible so operators can share diagnostic URLs.
- Treat destructive or broad actions as explicit confirmed operations. Rebuild group/context actions stay behind confirmation dialogs or panels, and operation cancellation is shown only for cancellable states.
- Prefer server-side filtering and bounded limits for operations, blocked streams, and history. Do not load every poison-event detail by default.
- Keep status meaning accessible without color. Badges must include text labels and counts; error/attention summaries must not rely on green/red alone.
- Add missing design-system capability only when the page need is generic: sticky table header, compact operations table variant, row detail affordance, or page-level operations console pattern should live in `packages/design-system`, not as local overrides.

## Stress Test

- Normal flow: all projections caught up, no operations active, workers fresh. The page should show a quiet healthy summary and hide noisy details behind tabs.
- Partial flow: some groups running while lag remains. The page should distinguish "running and draining" from "behind and idle/stale".
- Stale data: worker snapshots older than the freshness threshold should be labelled stale and should not appear as current truth.
- Replay/rebuild: rebuild operations should show queued/running progress, claim owner, timestamps, target, and terminal result without implying synchronous completion.
- Failure/cancellation: failed and cancel-requested operations should be visible in the first viewport with detail links and safe next actions.
- Cross-context handoff: projection group rows should identify target context, source contexts, projection group, reset strategy where available, and owned tables only in details.
- Incident load: the overview endpoint remains cheap; blocked stream and poison details load on demand and with limits.
- Accessibility: keyboard users can navigate filters, tabs, tables, details, retry/rebuild/cancel actions, and dialogs; color is never the only state indicator.

## Implementation Checklist

### 1. Establish ownership and route composition

- [x] Add `bounded-contexts/platform-operations/README.md` with purpose, owns/does-not-own, and boundary notes.
- [x] Add `bounded-contexts/platform-operations/GLOSSARY.md` defining Projection Operation, Projection Group, Subscription, Blocked Stream, Poison Event, Worker, Runner, Snapshot Freshness, Source Lag, Applicable Lag, and Attention.
- [x] Add `bounded-contexts/platform-operations/context.json` with a `projection-operations` slice, admin-web route contribution for `/operations/projections`, and appropriate public exports.
- [x] Add package scaffolding for `@chase-sets/platform-operations`.
- [x] Move admin projection operation route adapter from `deployables/admin-web/app/routes/projection-operations.tsx` into the new context route surface.
- [x] Leave `deployables/admin-web/app/routes.ts` as generated/thin composition with no direct platform operation page ownership.
- [x] Update workspace metadata generation if needed so the new context contributes to `admin-web`.

### 2. Split data contracts from rendering

- [x] Move snapshot DTOs, normalization, formatting, and state-resolution helpers into `bounded-contexts/platform-operations/features/projection-operations/read-model`, `ui`, and `api` modules.
- [x] Add explicit view models for Overview signals, Attention items, Operation rows, Projection Group rows, Subscription rows, Blocked Stream rows, Worker/Runner rows, and Detail panel models.
- [x] Preserve decimal-string count handling for large global positions.
- [x] Preserve `behind + running runner => running` operator-state resolution and cover it with tests.
- [x] Add API client functions for list snapshot, route filters, retry stream, rebuild group/context, refresh snapshot, and cancel operation.
- [ ] Add dedicated API client functions for operation detail, blocked stream detail, server-side operation filtering, and future pagination/cursor work.

### 3. Redesign first viewport

- [x] Replace the current page header plus large stats grid with an operations summary band focused on health and attention.
- [x] Show primary state: `Healthy`, `Needs attention`, `Running`, `Stale`, or `Unavailable`, derived from summary, operation summary, worker freshness, and status source.
- [x] Show compact signal tiles for failed operations, cancel-requested operations, queued/running operations, oldest queued/running age, degraded/error groups, blocked streams, poison events, source lag, applicable lag availability, active/stale workers, stale revisions, and last updated.
- [x] Add a freshness marker from `projectionStatusSource` and snapshot metadata when available.
- [x] Add primary actions: refresh status, view failures/attention, view operations history.
- [x] Add guarded actions: rebuild context/group and retry blocked stream only when a relevant context or detail view is selected.

### 4. Add failure-first navigation

- [x] Use design-system `Tabs` for `Overview`, `Attention`, `Operations`, `Projection Groups`, `Subscriptions`, `Blocked Streams`, `Workers`, and `Diagnostics`.
- [x] Default to `Attention` when any failed, cancel-requested, degraded, blocked, poison, stale worker, or stale revision signal exists.
- [x] Keep `Overview` concise when no attention items exist.
- [x] Add URL query state for filters and selected record, with tab query support for direct links.
- [ ] Add an "attention only" filter that spans projections, subscriptions, workers, and operations.

### 5. Improve filtering and sorting

- [x] Add `FilterArea` for context, projection, state, operation kind, requested by, worker state, and search.
- [x] Add `AppliedFilterChips` and a clear-filters action.
- [ ] Use API-supported operation filters for operations history instead of client-only filtering.
- [x] Add row sorting for state severity and subscription lag.
- [x] Default core tables to most actionable rows first.
- [ ] Add complete row sorting for updated time, queued age, blocked count, poison count, and context/projection name.
- [ ] Add bounded result controls or pagination for operation history and blocked stream details.

### 6. Replace table dump with progressive detail

- [x] Use one primary table per tab rather than stacking all data in one long document.
- [x] Add a selected-row detail panel for operation, projection group, subscription, blocked stream, poison event, worker, and runner records.
- [x] In operation detail, show lifecycle timestamps, target, requester, claim owner, operation ID, error payload, and available cancellation state.
- [x] In projection group detail, show target context, sources, revision/stored revision, required during bootstrap, owned tables, last error, and available rebuild action.
- [x] In subscription detail, show checkpoint key, source/target, version, positions, source lag, applicable lag, blocked/poison counts, and last error.
- [x] In blocked stream detail, show poison events already present in the snapshot with event ID, type, global position, error, and retry action.
- [x] In worker/runner detail, show recorded heartbeat/runner fields available in the snapshot.
- [ ] Add lazy-loaded operation, blocked stream, and worker detail endpoints for progress messages, reset strategy, first/last seen poison metadata, and richer fencing metadata.

### 7. Improve table usability and design-system support

- [x] Use compact density for high-volume tables and comfortable density for summaries/details.
- [x] Right-align numeric counts, lag, positions, retry counts, and durations.
- [ ] Keep identifiers copyable and truncated only with full value available in details.
- [ ] Add sticky table headers or a design-system issue/extension if `DataTable` should own this pattern.
- [ ] Add row click/selection affordance through design-system extension rather than custom row wrappers.
- [ ] Add loading skeletons and empty states per tab.
- [x] Avoid cards inside cards; use page bands, tabs, tables, and detail panels consistently.
- [x] Verify dark-theme desktop and mobile rendering for table headers, borders, status badges, focus outlines, and text.

### 8. Add actions and safety rails

- [x] Add refresh action that calls the existing `/refresh` endpoint and reports whether data is live refreshed or snapshot-backed.
- [x] Add cancel operation action for `queued`, `running`, and `cancel_requested` states where the API supports it.
- [x] Add retry stream only from blocked stream or poison-event detail.
- [x] Add rebuild group only from projection group detail and require explicit confirmation.
- [x] Add rebuild context only when a context is selected or singular and require explicit confirmation.
- [ ] After an action, show queued operation ID, target, state, and link/select the operation detail.
- [ ] Disable repeated destructive actions while a matching queued/running operation exists.
- [ ] Surface API errors inline and through existing toast/notice patterns if available in the new context.

### 9. Update API only where the UI cannot answer required questions

- [ ] Include snapshot freshness metadata consistently in the list snapshot response if not already available for every source.
- [ ] Expose reset strategy and owned-table detail in projection group responses if the runtime already knows them.
- [ ] Add operation progress summary fields to operation list/detail if workers already persist them.
- [ ] Add safe server-side pagination and cursors/limits for operation history and blocked stream details if current limit-only behavior is insufficient.
- [ ] Avoid adding business meaning or context-specific repair policy to `platform-runtime`.
- [x] Preserve `security.manage` permission requirements on projection operations API and admin route access.

### 10. Update localization and terminology

- [x] Move projection operations localization keys from `adminWeb.app.routes.projectionOperations.*` to the new platform-operations namespace.
- [x] Use natural operator language: `Needs attention`, `Source lag`, `Applicable lag`, `Blocked stream`, `Poison event`, `Snapshot freshness`, `Worker heartbeat`, `Cancel requested`.
- [x] Avoid ambiguous labels like `outstanding` without context; prefer `Source lag` plus `Applicable lag`.
- [x] Add concise empty-state and loading-state copy per tab.
- [x] Add action confirmation copy that explains impact without relying on implementation jargon.

### 11. Testing and verification

- [x] Add unit tests for normalization and derived view-model severity ordering.
- [x] Add route/component tests for healthy, degraded, failed operation, cancel-requested operation, blocked stream, poison event, stale worker, selected detail, and empty-state scenarios.
- [x] Add action/client tests for retry, rebuild group, rebuild context, refresh, and cancel URL construction.
- [ ] Add accessibility tests for tabs, filters, table controls, detail panel, dialogs, and action buttons.
- [x] Add visual or screenshot checks for desktop and mobile layouts via Playwright against local admin-web.
- [x] Run `pnpm --filter @chase-sets/platform-operations test`.
- [x] Run `pnpm --filter @chase-sets/platform-operations typecheck`.
- [x] Run `pnpm --filter @chase-sets/app-admin-web test`.
- [x] Run `pnpm --filter @chase-sets/app-admin-web typecheck`.
- [x] Run affected platform-runtime tests.
- [x] Run `pnpm run verify:metadata`, `pnpm run verify:static`, `pnpm run verify:typecheck`, `pnpm run verify:test`, and `pnpm run verify:build`.

### 12. Documentation and rollout

- [x] Update `docs/runbooks/projection-operations.md` with the new console workflow and attention-first triage path.
- [x] Update `docs/runbooks/projection-poison-events.md` for retry-from-detail workflow.
- [ ] Add design-system documentation or tests for any new operations-console table/detail/filter pattern.
- [x] Update `docs/README.md` if new durable docs are added.
- [ ] Include migration notes for the new `platform-operations` context and removed deployable-owned route.
- [x] Verify the page against seeded local data with many projection groups, subscriptions, workers, and selected detail on desktop and mobile before PR.

## Documentation To Promote

- `bounded-contexts/platform-operations/README.md`
- `bounded-contexts/platform-operations/GLOSSARY.md`
- `docs/runbooks/projection-operations.md`
- `docs/runbooks/projection-poison-events.md`
- `docs/README.md` if the new context docs or runbook entries should be indexed
- `packages/design-system` docs/tests for any new table/detail/filter capability

## Open Questions

No blocking question. Recommended default: create `platform-operations` as a new bounded context because the workflow is cross-context operational behavior with its own ubiquitous language, UI, API client, tests, and runbooks. Choosing to keep this page in `admin-web` would be faster short-term but would preserve the current deployable-owned UI contradiction.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
