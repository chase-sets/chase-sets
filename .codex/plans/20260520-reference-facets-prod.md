# Reference Facets Production Fix

## Intent

Get the Discovery search facet fix to production so rich reference facets such as Expansion, Series, and Manufacturer appear in marketplace search when projected from Catalog reference records.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-reference-facets-prod`
- Branch: `codex/reference-facets-prod`
- Sandbox id: `c0410397`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox status: `pnpm run sandbox:doctor` passed
- Setup blockers: none found

## Owning Contexts

- Discovery owns Search Index, Discovery Query, Filter State, Facets, Result Set ranking, and search presentation.
- Catalog owns canonical Reference Records, Field definitions, and reference hierarchy facts projected into Discovery.
- Design System owns reusable filter/facet presentation components, but the failure is before UI rendering because hidden facet groups are omitted from Discovery's response.

## Resolved Decisions

- Ownership: implement in `bounded-contexts/discovery/features/search/read-model` because Discovery decides filter presentation, ranking, query normalization, and counts.
- Language: use Discovery's canonical terms: Facet, Filter, Filter State, Result Set, Search Index, Discovery Query.
- Invariant: selected facet groups remain visible; unselected groups must be ranked by buyer decision value before any bounded group cap is applied.
- Read model: keep existing `field_filter_values` projection shape and related reference IDs such as `field.<field_id>:<reference_type_key>`.
- API: keep the existing `/api/marketplace/items` response contract. No schema migration or URL contract change is needed.
- UI: no direct design-system or route change is needed because the UI already renders the dynamic facet groups returned by Discovery.
- Operations: this is a query/ranking fix. Existing projected data does not need a replay because the missing groups are already in `field_filter_values`.
- Rebase finding: current `main` promotes rich references into first-class `reference_filter_values`; the production fix now ranks those `kind: "reference"` groups directly instead of relying on derived Field facet IDs.

## Implementation Checklist

- Completed: add deterministic facet group decision priority in Discovery facet ordering.
- Completed: apply decision priority before selecting bounded dynamic facet groups.
- Completed: increase the bounded dynamic facet group limit enough to expose buyer-critical reference facets without overwhelming the filter rail.
- Completed: add regression tests proving Expansion, Series, and Manufacturer remain visible even when generic facets have higher raw coverage.
- Completed after rebase: focused Discovery search read-model tests passed.
- Completed after rebase: full Discovery test suite passed.
- Completed after rebase: repository no-`any` check passed.
- Local blocker documented: Discovery TypeScript check timed out after five minutes; CI must provide the authoritative typecheck signal.
- Commit the plan and implementation.
- Open a PR.
- Wait for CI to pass.
- Merge after required review/checks.
- Verify staging deployment is green.
- Verify production deployment is green after promotion or rollout.

## Documentation To Promote

- No durable docs need promotion for this fix. Existing Discovery dynamic-search-filter docs and design-system marketplace policy already state the intended ranking behavior.

## Stress Test

- Normal flow: Catalog reference records continue projecting into Discovery; search response now includes buyer-critical reference facets when available.
- Partial flow: if a reference relationship is missing, the existing projection omits that related facet and ranking has nothing extra to expose.
- Stale data or replay: no replay required because the fix reads existing `field_filter_values`; replay remains safe because the projection shape is unchanged.
- Cross-context handoff: Catalog remains owner of reference records; Discovery only ranks projected browse affordances.
- Failure or cancellation: if CI or deployment fails, keep the branch and plan for rollback/fix-forward instead of changing deployed data.
- Low-value card economics: better Expansion/Series/Manufacturer filtering reduces buyer search effort and supports efficient set-sized low-value card workflows.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
