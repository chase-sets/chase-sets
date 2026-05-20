# Catalog Items Publish All Matches

## Intent

Catalog Items operators need to publish all matching imported draft Catalog Items without selecting every visible row. The existing backend already supports filter-wide bulk publish and confirms against previewed IDs, so this change should expose publish matching drafts in the Catalog Items matching-scope bulk action area and keep the operation draft-only.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-catalog-items-publish-all-matches`
- Branch: `codex/catalog-items-publish-all-matches`
- Sandbox id: `435fded3`
- Dependency setup status: complete (`pnpm run deps:install`)
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Catalog owns Catalog Item lifecycle transitions, provider Source Observations, promotion into canonical Catalog Items, Catalog Item read models, admin UI contracts, and admin route modules.
- Discovery is not an owner for this change because browse/search filtering behavior is buyer-facing, while this workflow is Catalog admin authoring and lifecycle orchestration.

## Resolved Decisions

- Ownership: Catalog, specifically the `catalog-items` slice, owns the UI behavior and request contract. Repo evidence: `bounded-contexts/catalog/README.md`, `bounded-contexts/catalog/context.json`, and `bounded-contexts/catalog/docs/bulk-catalog-item-publish.md`.
- Language: use `Catalog Items`, `draft`, `matching`, `preview`, `publish`, and `ready` to match existing Catalog admin copy. Avoid introducing a new term such as "all results".
- Invariants: filter-wide publish remains draft-only. The server must continue resolving the filter to explicit Catalog Item IDs during preview and confirmation must publish the previewed IDs.
- Events and commands: no new events or commands. Bulk publish must continue orchestrating the existing `PublishCatalogItem` command for each ready Catalog Item.
- Read models and APIs: no new endpoint is needed. Existing `/api/catalog/items/bulk-publish/preview` accepts `{ mode: "filter", query }`, and `/confirm` accepts previewed `itemIds`.
- UI: add matching-scope publish affordance beside existing matching-scope lifecycle and bulk edit actions, and use the full current Catalog Item query so workflow filters like blueprint assignment, images, source references, and missing required fields remain part of the scope.
- Operations: partial success remains visible in the existing preview/result dialog.

## Implementation Checklist

- Done: Move filter-wide publish from the header-only `Preview Filtered Drafts` affordance into the matching-scope bulk action area.
- Done: Build the matching publish selection from the current route query and force `status: "draft"` only at the publish boundary.
- Done: Preserve selected-row publish behavior unchanged.
- Done: Update Catalog Items UI tests to cover matching-scope publish with workflow filters and selected-row behavior.
- Done: Update localization copy for the matching-scope button and preview scope.
- Done: Run worktree dependency setup, sandbox doctor, targeted Catalog tests, localization check, and TypeScript verification.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `435fded3`.
- `pnpm --filter @chase-sets/catalog test -- catalog-item-list-page.test.tsx route.test.ts` passed: 3 files, 25 tests.
- `pnpm run check:localization` passed for 416 source files.
- `pnpm run verify:typecheck` passed, including no-explicit-any and workspace typechecks.

## Documentation To Promote

No durable docs need promotion unless implementation reveals a contradiction. Existing Catalog docs already specify filter-wide bulk publish policy.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
