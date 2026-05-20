# Mobile Action Group

## Intent

Replace the mobile item-detail market intent toggle plus repeated action button with a direct three-button action group: Buy, Sell, and Watch. Each button should open the relevant mobile commerce bottom sheet so mobile users do not need to choose an intent and then confirm the same intent.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-mobile-action-group`
- Branch: `codex/mobile-action-group`
- Sandbox id: `58cb3f6a`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Discovery owns the Detail Page and Product Alert watch behavior. The mobile commerce entry point lives in `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`.
- Marketplace owns Listing and Offer lifecycle facts surfaced through Discovery projections, but this change does not alter Marketplace behavior.
- The design system owns the canonical action bar primitive. The existing `CommerceActionBar` already supports three actions, so no custom mobile shell override is needed.

## Resolved Decisions

- Keep implementation inside Discovery's `item-detail` slice because this is a Detail Page interaction change.
- Preserve desktop behavior and the existing desktop buy/sell intent control.
- Remove the mobile market intent toggle from `CommerceActionBar`.
- Show direct mobile actions for Buy, Sell, and Watch. Buy opens the buy sheet, Sell opens the sell sheet, and Watch opens the alert/watch sheet.
- Use the existing mobile bottom sheet pattern and section content instead of adding a new panel component.
- Add the Watch mobile section through the existing `mobile` commerce section contract so Product Alert behavior stays Discovery-owned.

## Open Questions

- None. The user requested Buy, Sell, and Watch buttons, and repo evidence shows the needed Product Alert content already exists in the buy/sell action cards.

## Implementation Checklist

- [x] Update mobile commerce actions in `item-detail-page.tsx`.
- [x] Add a Watch mobile section in the item-detail route composition.
- [x] Update Discovery item-detail tests for the new three-button mobile action group.
- [x] Run focused tests for the Discovery item-detail commerce panel.
- [x] Run Discovery context tests.
- [x] Run localization checks.
- [x] Run typecheck.
- [x] Verify mobile item-detail Buy/Sell/Watch action group and Watch sheet in a 390px viewport.

## Documentation To Promote

- No durable docs expected. This is a small UI flow correction that follows existing Discovery and design-system patterns.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
