# Sell Dropdown Outside Click

## Intent

Fix the marketplace Sell menu so an open dropdown closes when the user clicks outside of it.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-sell-dropdown-outside-click`
- Branch: `codex/sell-dropdown-outside-click`
- Base: current local `main` at `8cc4f1e6`
- Sandbox id: `23c9e8ce`
- Dependency setup: complete via `pnpm run deps:install`
- Sandbox doctor: passed via `pnpm run sandbox:doctor`
- Setup blockers: none known

## Owning Contexts

- Marketplace owns the Sell navigation grouping and seller workflow entries.
- The design system owns `TopNav` child-menu interaction behavior. The defect is component-level because Marketplace supplies `children`, while `packages/design-system/src/components/actions/navigation.tsx` renders those children with a native `details`/`summary` dropdown that has no outside-click close behavior.

## Resolved Decisions

- Keep Marketplace navigation composition unchanged.
- Implement the outside-click close behavior in the design system so every `TopNav` grouped menu gets the same behavior.
- Add focused design-system coverage around child-menu outside clicks.
- Verified the Marketplace Sell group is assembled in `deployables/marketplace/app/host.ts`, while the interactive grouped menu is rendered by `packages/design-system/src/components/actions/navigation.tsx`.

## Open Questions

- None blocking. The requested behavior and owner are clear from code.

## Implementation Checklist

- [x] Replace or enhance the `TopNav` grouped child-menu implementation so outside pointer interactions close an open menu.
- [x] Preserve current link rendering, active state, keyboard-friendly native summary behavior, and visual classes.
- [x] Add a regression test that opens the Sell-style grouped menu, clicks outside, and observes the menu closing.
- [x] Run focused design-system tests.
- [x] Run marketplace layout coverage for the Sell group composition.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `pnpm run test:design-system`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/layout.test.tsx`

## Documentation To Promote

- None expected. This is a component behavior correction rather than a durable domain or architecture decision.

## Goal Completion Criteria

- Implementation remains in the feature worktree.
- Plan artifact is retained with the implementation.
- Design-system tests cover the outside-click regression.
- Focused automated checks pass.
- Visual behavior is checked where feasible for desktop and mobile navigation surfaces.
- Any PR must include this plan and the targeted verification result.
