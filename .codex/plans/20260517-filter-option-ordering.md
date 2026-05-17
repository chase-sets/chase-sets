# Filter Option Ordering

## Intent

Discovery filter facets should order values by the meaning of the facet, not by incidental result counts. Year filters show newest to oldest, Expansion/Set filters show newest releases first when release metadata exists, numeric Grade filters show highest to lowest, ordered Condition filters preserve Catalog's best-to-worst option order, and unordered facets remain stable and readable.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-filter-option-ordering`
- Branch: `codex/filter-option-ordering`
- Sandbox id: `5437532d`.
- Dependency setup status: complete via `pnpm run deps:install`.
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none known; `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Discovery owns browse/search, Filter State, Facets, facet presentation, and the search read model.
- Catalog owns canonical Field, Reference Record, Dimension, Option, `valueKind`, `displayOrder`, and `numericValue` facts that Discovery projects.
- No deployable owns this behavior; deployables remain thin route composition roots.

## Resolved Decisions

- Behavior owner: Discovery search read model and projection.
- Stable published facts: Catalog `field.configured`, `reference-record.*`, `dimension.*`, `dimension.option-*`, and `dimension.options-reordered` events.
- Ordering policy lives in a Discovery search read-model helper so field and dimension facet values use one policy surface.
- Field facets keep selected values visible and order by semantic metadata where available:
  - values whose field label/id indicates Year sort by numeric value descending.
  - reference values with a `release-date` attribute, including Expansion/Set references, sort by release date descending.
  - other numeric field values sort by numeric value descending when they are clearly numeric.
  - otherwise values fall back to count desc, then label asc, then id asc.
- Dimension facets order from Catalog semantics:
  - `numeric` dimensions sort by numeric value descending, with display order as fallback.
  - `ordered` dimensions sort by display order ascending, preserving curated ordering such as Condition best-to-worst.
  - `unordered` dimensions fall back to count desc, label asc, id asc.
- Discovery search projection must consume `catalog.dimension.options-reordered` so facet and bulk-preview option order stay consistent after replay or reorder events.
- No durable docs are needed beyond the retained plan; this is an implementation detail of the Discovery read model using existing glossary terms.

## Open Questions

- None blocking. The user examples map to existing Catalog facts and Discovery ownership.

## Implementation Checklist

- [x] Add a Discovery search read-model helper for facet value ordering policy.
- [x] Enrich field facet filter values with `valueType`, optional numeric sort value, optional release date, and a deterministic fallback label.
- [x] Enrich dimension facet filter values with `valueKind`, `displayOrder`, and `numericValue`.
- [x] Change field and dimension facet value queries to order through the helper policy instead of raw count.
- [x] Add the missing search projection handler and context subscription for `catalog.dimension.options-reordered`.
- [x] Cover year, expansion, numeric grade, ordered condition, and fallback ordering with focused tests.

## Verification

- `pnpm --filter @chase-sets/discovery test` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run check:structure` passed.

## Documentation To Promote

- None. The retained plan is sufficient unless this policy becomes a public API guarantee.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
