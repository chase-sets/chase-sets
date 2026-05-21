# Reference Field Value Cue

## Intent

Reference-backed Catalog Item field values should not look like action buttons in the Field Values table. They should keep the same text scale as other values while still signaling that the value carries Reference Record details.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-reference-field-value-cue`
- Branch: `codex/reference-field-value-cue`
- Sandbox id: `c2e8d073`
- Dependency setup status: installed with `pnpm run deps:install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found

## Owning Contexts

- Catalog owns Catalog Items, Fields, Reference Types, Reference Records, and the admin route contributions.
- The change belongs in `bounded-contexts/catalog/features/catalog-items/ui` because the visual affordance is specific to Catalog Item field-value display.
- Deployables stay thin; no admin-web composition change is needed.

## Resolved Decisions

- Keep the click behavior that opens Reference Record detail, because the existing UI and tests treat reference-backed field values as navigable detail rows.
- Replace the button visual treatment with the design-system `LinkText` pattern. This preserves text-sized table scanability while signaling that the value has reference metadata.
- Do not move the pattern into shared design-system code until another slice needs the same reference-value affordance.

## Implementation Checklist

- [x] Replace `ReferenceValueButton` with a reference-value affordance that does not render design-system `Button`.
- [x] Render reference values as design-system text links with a reference destination.
- [x] Preserve in-place reference detail access for normal clicks.
- [x] Update the catalog item detail test to assert reference values no longer render as buttons and still open details.
- [x] Run targeted catalog item UI tests.
- [x] Run TypeScript no-emit verification.

## Verification

- `pnpm exec vitest run features/catalog-items/ui/catalog-item-detail-page.test.tsx --config tests/vitest.config.mjs` from `bounded-contexts/catalog`: passed, 3 tests.
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`: passed.

## Documentation To Promote

- None. This is a local UI presentation adjustment that follows existing Catalog ownership docs.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
