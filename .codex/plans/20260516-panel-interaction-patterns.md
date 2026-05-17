# Panel Interaction Patterns

## Intent

Update design-system documentation and component APIs so product and engineering teams can choose panel-based interaction patterns consistently across desktop, tablet, mobile, and small mobile surfaces. Apply that guidance to the marketplace UX findings by replacing generic drawer terminology with canonical sheets, sidebars, modal dialogs, and full-page flows where the existing code already exposes those interaction seams.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260516-panel-interaction-patterns`
- Branch: `codex/panel-interaction-patterns`
- Sandbox id: not assigned; component and documentation pass does not need a running app sandbox.
- Dependency setup status: available from repository workspace; design-system typecheck and tests already run in this worktree.
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store` would be used if verification later needs dependencies.
- Setup blockers: none.

## Owning Contexts

- Design system package: `packages/design-system/` owns reusable UI component and pattern guidance.
- Discovery owns search and item-detail marketplace buyer/seller discovery UI that consumes filter and commerce panels.
- Marketplace owns listing lifecycle pages and seller workflows; destructive listing actions should use blocking Modal Dialogs, while create/edit flows remain Full Page.
- Notifications owns notification center feed/settings behavior; design system owns the responsive shell pattern used to present that feed.
- Identity owns account shipping addresses; archival actions are blocking decisions, while long address editing remains a page/sheet decision by form complexity.
- Checkout and Settlement own money workflows that remain Full Page experiences with supporting summary sidebars where useful.
- Product contexts keep workflow behavior, read models, and domain decisions; deployables remain thin composition roots.

## Resolved Decisions

- Create a dedicated design-system pattern document instead of expanding marketplace-only guidance. Panel taxonomy is package-wide, not marketplace-specific.
- Use the requested natural-language names as canonical names: Navigation Drawer, Sidebar, Side Sheet, Bottom Sheet, Modal Dialog, Popover/Menu, and Full Page.
- Treat existing `Drawer` component exports as implementation primitives, while documentation forbids using "drawer" as a generic design-system pattern name.
- Keep `Drawer` as a low-level implementation primitive, but expose canonical app-facing wrappers: `MarketplaceFilterBottomSheet`, `CommerceBottomSheet`, `NotificationCenterSheet`, `FilterBottomSheet`, and `Sidebar` usage in layout helpers.
- Preserve deprecated compatibility aliases for existing `*Drawer` names during migration, but do not use those aliases in updated marketplace consumers.
- Map desktop side sheets to mobile bottom sheets only for lightweight contextual interactions. Rich details, complex edits, and sequential tasks become full-page flows on mobile.
- Prefer modal dialogs only for blocking decisions or short focused tasks. Non-blocking supporting content belongs in sheets or pages.
- Update notification `context.json` to stop describing the notification center as a drawer; the durable language is responsive side sheet or bottom sheet.
- Stress-test: search filters are lightweight controls and map to a mobile Bottom Sheet; item-detail buy/offer controls are contextual and map to a mobile Commerce Bottom Sheet; checkout, cart, payment, payout, and listing creation/editing remain Full Page because they are sequential or money-sensitive.

## Open Questions

- None blocking. The requested taxonomy and repo ownership evidence are sufficient for a documentation-only change.

## Implementation Checklist

- [x] Create isolated worktree and branch.
- [x] Read bounded-context map, Experience context, bounded-context structure, and current design-system docs.
- [x] Search existing design-system and architecture docs for drawer, sheet, modal, popover, dialog, sidebar, panel, and bottom terminology.
- [x] Add panel interaction pattern documentation under `packages/design-system/`.
- [x] Add canonical design-system component wrappers for Navigation Drawer, Sidebar, Side Sheet, Bottom Sheet, Modal Dialog, and Full Page.
- [x] Link the new guidance from `packages/design-system/README.md` and `docs/README.md`.
- [x] Align nearby notification and marketplace references that used "drawer" as a generic panel name.
- [x] Run Markdown/doc verification.
- [x] Run design-system typecheck and tests.
- [x] Replace generic marketplace drawer wrappers with canonical sheet names and deprecated aliases.
- [x] Update Discovery search mobile filters to use `MarketplaceFilterBottomSheet`.
- [x] Update Discovery item-detail mobile commerce to use `CommerceBottomSheet`.
- [x] Update Notifications center shell to use `NotificationCenterSheet` and align context metadata.
- [x] Retire legacy `FilterDrawer` and `MarketplaceFilterDrawer` behind canonical bottom-sheet aliases.
- [x] Apply sidebar semantics to desktop filter and summary/supporting layouts without changing workflow ownership.
- [x] Add modal-dialog guardrails for destructive marketplace/identity actions where the current route can support a focused confirmation.
- [x] Re-run design-system and affected bounded-context verification.

## Documentation To Promote

- `packages/design-system/PANEL_INTERACTIONS.md`
- `packages/design-system/README.md`
- `docs/README.md`
- `packages/design-system/MARKETPLACE_SYSTEM.md`
- `packages/design-system/PROGRESSIVE_DISCLOSURE.md`
- `docs/architecture/notification-center-and-settings.md`
- `bounded-contexts/notifications/README.md`
- `bounded-contexts/notifications/GLOSSARY.md`
- `packages/design-system/src/components/feedback/dialog.tsx`
- `packages/design-system/src/components/feedback/panel-interactions.tsx`
- `packages/design-system/src/components/feedback/index.ts`
- `packages/design-system/src/__tests__/design-system.test.tsx`
- `packages/design-system/src/__tests__/design-system-parity.test.tsx`
- `packages/design-system/src/components/data-display/filter.tsx`
- `packages/design-system/src/components/data-display/index.ts`
- `packages/design-system/src/components/ui/marketplace.tsx`
- `packages/design-system/src/patterns/app-shells.tsx`
- `bounded-contexts/discovery/features/search/ui/search-page.tsx`
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`
- `bounded-contexts/notifications/context.json`
- `bounded-contexts/notifications/features/notification-center/ui/notification-center-shell.tsx`
- `bounded-contexts/marketplace/features/listings/ui/listing-detail-page.tsx`
- `bounded-contexts/identity/features/shipping-addresses/ui/shipping-address-page.tsx`
- `contracts/localization/locales/en.ts`

## Goal Completion Criteria

- Durable design-system guidance covers the requested taxonomy, desktop guidance, mobile guidance, responsive mapping, accessibility, API recommendations, do/don't examples, example scenarios, governance rules, and QA checklist.
- Documentation uses enforceable rules that distinguish navigation, sheets, dialogs, popovers, and full-page flows.
- Existing cross-context docs remain consistent with the new taxonomy, especially notification center and dynamic search filter guidance.
- Verification confirms the Markdown files are present and linked from the curated docs map.

## Verification

- `git diff --check`
- `rg -n "[ \t]+$" <touched markdown files>`
- PowerShell Markdown link target check across the nine touched Markdown files.
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/design-system run test`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run verify:typecheck`
- `pnpm --filter @chase-sets/discovery run test`
- `pnpm --filter @chase-sets/marketplace run test`
- `pnpm --filter @chase-sets/identity run test`
- `pnpm --filter @chase-sets/notification-center run test:fast`

## Implementation Notes

- Canonical marketplace components now expose `MarketplaceFilterBottomSheet`, `CommerceBottomSheet`, and `NotificationCenterSheet`; old `*Drawer` exports remain only as deprecated aliases.
- `SearchResultsLayout`, `CheckoutLayout`, and `InspectorLayout` now use `Sidebar` for desktop supporting regions while preserving full-page checkout/cart/payment/payout flows.
- Discovery search mobile filters consume `MarketplaceFilterBottomSheet`; Discovery item detail mobile commerce consumes `CommerceBottomSheet`.
- Notification Center shell consumes `NotificationCenterSheet`, and Notifications metadata now describes the responsive side sheet / bottom sheet instead of a drawer.
- Listing withdraw and shipping-address archive actions now use `ModalDialog` confirmation surfaces with localized descriptions.
- A first discovery test run failed because the new desktop sidebar and existing mobile filter bar shared `aria-label="Search filters"`; the desktop rail now uses `Desktop search filters` to keep both assistive labels distinct.
