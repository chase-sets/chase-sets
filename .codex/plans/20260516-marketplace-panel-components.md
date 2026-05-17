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

## Documentation To Promote

- Keep this plan committed as the durable implementation note.
- Update design-system docs only if implementation names differ from the existing panel taxonomy.

## Goal Completion Criteria

- All 8 review findings have implementation changes or an explicit preserve decision.
- Design-system tests cover responsive sheet/account behavior and reject deprecated drawer aliases.
- Affected bounded-context tests pass.
- `check:structure`, localization, typecheck, and diff hygiene pass.
- Branch is committed, pushed, and opened as a PR.
