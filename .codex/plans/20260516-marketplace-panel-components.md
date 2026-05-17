# Marketplace Panel Components

## Intent

Address the marketplace panel review by replacing ambiguous or incorrectly responsive surfaces with the canonical design-system interaction patterns from `PANEL_INTERACTIONS.md`.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-marketplace-panel-components`
- Branch: `codex/marketplace-panel-components`
- Base: `origin/main` at `8aeb49d2`
- Sandbox id: `ec779e83`
- Dependency setup: complete via `pnpm run deps:install`
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Design system owns canonical panel primitives, responsive marketplace wrappers, naming, and governance.
- Discovery owns search filters, bulk-add preview, and product detail browse surfaces.
- Identity owns shipping-address account management.
- Checkout owns cart and checkout session surfaces.
- Notifications owns the notification center and notification settings surface.
- Ordering and Payments own full-page order/payment review surfaces.
- Deployables remain thin composition roots; marketplace host may only compose navigation/account menu data.

## Resolved Decisions

- Use a responsive commerce sheet for search bulk-add preview: desktop/tablet side sheet, mobile bottom sheet. This keeps users in search context without rendering a mobile-only bottom sheet on desktop.
- Add `summaryLabel` to `CheckoutLayout` and update consumers so support sidebars announce their actual purpose.
- Make `NotificationCenterSheet` responsive by composing a desktop `SideSheet` with a mobile `BottomSheet`, preserving the Notifications README invariant.
- Wrap product-detail desktop commerce rail in the canonical `Sidebar` instead of a raw `aside`.
- Add a responsive account menu wrapper that keeps the desktop popover/menu and uses a mobile bottom sheet when the menu has more than four items.
- Replace inline per-address edit forms with a single editing surface: desktop side sheet, mobile full-height bottom sheet. Keep archive as a modal dialog because it is destructive and blocking.
- Remove deprecated drawer aliases from the design-system public surface and add a structure guard that blocks non-navigation `*Drawer` usage in marketplace UI.
- Preserve full-page money and sequential flows; only improve support-sidebar labels for cart, checkout, orders, and payments.
- Second-pass review found no broad bounded-context replacement needed. Remaining recommended changes are design-system governance and reusable wrappers: a responsive action menu for desktop `Menu` to mobile `BottomSheet` mapping, named support sheets for activity/comments/assistant/help panels, and a deprecation path from the duplicate `MarketplaceUiFilterBottomSheet` wrapper to canonical `MarketplaceFilterBottomSheet`.
- Keep these second-pass changes in the design system because no current Discovery, Marketplace, Identity, Checkout, Notifications, Ordering, or Payments feature owns the generic action/support-panel behavior. Bounded contexts should only consume the canonical wrappers when their slice introduces those interactions.

## Implementation Checklist

- [x] Add responsive marketplace panel wrappers in the design system.
- [x] Update design-system exports and tests for the new wrappers.
- [x] Replace search bulk-add `CommerceBottomSheet` with the responsive commerce sheet.
- [x] Add `summaryLabel` to `CheckoutLayout` and update cart, checkout, order detail, and payment consumers.
- [x] Make `NotificationCenterSheet` use desktop side sheet and mobile bottom sheet.
- [x] Convert product-detail desktop commerce rail to `Sidebar`.
- [x] Add responsive account menu behavior.
- [x] Move shipping-address edits into a single responsive edit panel.
- [x] Remove deprecated drawer aliases and update governance checks/docs.
- [x] Run focused and repository verification.
- [x] Add a responsive action menu wrapper for desktop anchored menus that become mobile bottom sheets.
- [x] Add support sheet wrappers for activity, comments, assistant, and help panels so future marketplace surfaces do not invent custom side/bottom sheet mappings.
- [x] Mark the legacy marketplace UI filter bottom-sheet wrapper as deprecated in favor of `MarketplaceFilterBottomSheet`.
- [x] Extend panel documentation, examples, and design-system tests for the second-pass wrappers.
- [x] Re-run focused design-system tests, structure, localization, typecheck, and diff hygiene.

## Documentation To Promote

- Keep this plan committed as the durable implementation note.
- Update design-system docs only if implementation names differ from the existing panel taxonomy.
- Promote the responsive action/support wrapper names in `packages/design-system/PANEL_INTERACTIONS.md`.

## Goal Completion Criteria

- All 8 review findings have implementation changes or an explicit preserve decision.
- Design-system tests cover responsive sheet/account behavior and reject deprecated drawer aliases.
- Affected bounded-context tests pass.
- `check:structure`, localization, typecheck, and diff hygiene pass.
- Branch is committed, pushed, and opened as a PR.
- Second-pass design-system wrappers and governance updates are committed, pushed, and included in the PR.
- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
