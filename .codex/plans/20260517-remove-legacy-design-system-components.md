# Remove Legacy Design System Components

## Intent

Remove deprecated and legacy design-system component APIs so the package exposes one canonical panel and menu taxonomy. This is a breaking cleanup aligned with the repository instruction that breaking changes are encouraged when they reduce entropy and improve clarity.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-remove-legacy-design-system-components`
- Branch: `codex/remove-legacy-design-system-components`
- Sandbox id: `3f9b7584`
- Dependency setup status: complete via `node ./scripts/worktree-deps.mjs install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passing
- Setup blockers: none

## Owning Contexts

- Design system package: owns reusable UI components, pattern names, responsive behavior, accessibility contracts, and exported component API shape.
- Marketplace bounded context: pressure-test consumer because its shell and filter wrappers previously had drawer compatibility names.
- Notifications bounded context: pressure-test consumer because Notification Center is explicitly a desktop side sheet and mobile bottom sheet.

## Resolved Decisions

- Remove deprecated public aliases instead of keeping shims:
  - `FilterDrawer`
  - `MarketplaceMobileFilterDrawer`
  - `MarketplaceFilterDrawer`
  - `CommerceDrawer`
  - `NotificationCenterDrawer`
- Remove the duplicate `MarketplaceUiFilterBottomSheet` wrapper from `components/ui/marketplace`; keep the canonical `MarketplaceFilterBottomSheet` from app-shell patterns.
- Stop exporting the low-level `Drawer`, `DrawerProps`, and `DrawerPlacement` from the public design-system surface. Keep any needed internal primitive code private to the feedback package.
- Remove the legacy `DropdownMenu` export and component in favor of canonical `Menu` and `ResponsiveActionMenu`.
- Update docs so they no longer describe legacy exports as available compatibility surfaces.
- No external product consumers currently import the deprecated aliases, so this is a design-system-contained breaking API cleanup.

## Implementation Checklist

- [x] Remove deprecated aliases from design-system source files and barrel exports.
- [x] Make panel interaction internals stop depending on public `Drawer` types where possible.
- [x] Remove legacy `DropdownMenu` from the public API and delete its component if no tests require it.
- [x] Update design-system tests and parity coverage to assert only canonical components.
- [x] Update `PANEL_INTERACTIONS.md` and `README.md` to remove compatibility language.
- [x] Run focused design-system tests and typecheck.
- [x] Run consumer typecheck/tests that cover marketplace and notifications.
- [x] Run localization, structure, full typecheck, and diff hygiene checks.

## Documentation To Promote

- `packages/design-system/PANEL_INTERACTIONS.md`
- `packages/design-system/README.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
