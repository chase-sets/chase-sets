# Admin Catalog Pattern Consistency

## Intent

Sweep the admin Catalog list surfaces plus related Experience and Identity admin surfaces so filters live only in filter bars and commands live in action bars.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-admin-catalog-pattern-consistency`
- Branch: `codex/admin-catalog-pattern-consistency`
- Sandbox id: `0a3295b4`
- Dependency setup status: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox setup status: `pnpm run sandbox:doctor` completed.
- Setup blockers: none.

## Owning Contexts

- Catalog owns Dimensions, Fields, Components, Blueprints, Categories, Catalog Items, Reference Data, Integrations, and Source Observations admin UI.
- Experience owns Platform Feedback admin review UI.
- Identity owns Accounts, Users, Memberships, Invitations, and API Keys admin UI.
- The deployable admin app remains a thin composition root; reusable UI structure stays in the design system or context-local shell support.

## Resolved Decisions

- Add a design-system action bar pattern instead of custom local surfaces, because the design system is the canonical source for UI patterns.
- Keep Catalog list-page composition in Catalog shell support and update slices through that shared surface where possible.
- Treat create/import, matching bulk operations, and detail lifecycle commands as actions, not filters.
- Keep search, status, provider, language, expansion, and other narrowing controls in filter bars.
- Use Catalog glossary terms: Catalog Item, Dimension, Field, Component, Blueprint, Category, Reference Type, Reference Record, Source Observation.

## Implementation Checklist

- Completed: Added and exported a design-system `ActionBar` component with focused tests.
- Completed: Updated Catalog `EntityListPage` and `EntityDetailPage` so commands render in an action bar, not the page header.
- Completed: Removed Source Observation matching promote/reject controls from the filter bar and rendered them in the bulk action bar.
- Completed: Updated Integrations so import is in an action bar and provider/language/expansion remain in the filter bar.
- Completed: Updated Experience Platform Feedback admin filters to use the filter bar and moved submit/review/archive commands into action bars.
- Completed: Updated Identity admin shell list pages to follow the page/header/table pattern while keeping future actions in an action bar.
- Completed: Verified with focused tests and static checks.

## Verification

- `pnpm exec vitest run bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.test.tsx bounded-contexts/catalog/features/source-observations/ui/integration-management-page.test.tsx bounded-contexts/experience/features/platform-feedback/ui/admin-pages.test.tsx`
- `pnpm exec vitest run --environment jsdom packages/design-system/src/__tests__/design-system.test.tsx -t "data-heavy admin filter bars|admin commands in action bars|admin bulk action bars"`
- `pnpm exec tsc --noEmit`
- `pnpm run check:no-any`
- `pnpm run check:structure`

Note: the full `packages/design-system/src/__tests__/design-system.test.tsx` file still has pre-existing jsdom isolation failures when run as a whole; the focused action/filter/bar tests pass.

## Documentation To Promote

- None expected beyond this retained plan. If the action bar becomes broader admin guidance, promote it to `packages/design-system/`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
