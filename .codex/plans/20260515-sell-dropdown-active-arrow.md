# Sell Dropdown Active Arrow

## Intent

Fix the design-system top navigation so a dropdown trigger keeps a visible chevron indicator when the trigger is active or open. The reported visible consumer is the `Sell` top navigation dropdown.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-sell-dropdown-active-arrow`
- Branch: `codex/sell-dropdown-active-arrow`
- Base: current source repo `main` at `8cc4f1e6`
- Sandbox id: `f948fc50`
- Dependency setup: `pnpm run deps:install` completed; node_modules present.
- Sandbox setup: `pnpm run sandbox:doctor` passed.
- Relevant local URLs: Marketplace `http://localhost:9603`; Admin web `http://localhost:9602`; Platform API `http://localhost:9612`.
- Setup caveats: source `main` is behind `origin/main` by 35 commits; no setup blocker found.

## Owning Contexts

- Design system owns the reusable top-navigation interaction primitive and visual states in `packages/design-system`.
- Marketplace is the visible business consumer because `Sell` represents seller-side marketplace workflows, but Marketplace should not own the reusable arrow/active-state styling.

## Resolved Decisions

- Keep the fix in `packages/design-system/src/components/actions/navigation.tsx`, not in Marketplace route or shell code.
- Treat the chevron as part of the dropdown trigger contract: any item with dropdown content must retain the indicator across inactive, hover, open, and active states.
- Cover the regression in `packages/design-system/src/__tests__/design-system-parity.test.tsx` because the existing parity suite already renders shell navigation patterns.
- Code finding: `TopNav` renders an active pill under active dropdown parents, but the dropdown chevron sits outside the `relative z-10` content wrapper, letting the active pill visually cover it.
- No glossary change is needed. `Sell` remains UI navigation language for marketplace seller workflows; no new domain noun or event is introduced.

## Open Questions

- None. Code and docs resolve the owner and expected surface.

## Implementation Checklist

- Completed: updated the design-system `TopNav` dropdown parent trigger so active dropdown states keep a visible chevron above the active pill.
- Completed: extended the design-system parity test to assert active dropdown parents still render the chevron indicator in the foreground stacking layer.
- Completed: `pnpm --filter @chase-sets/design-system test` passed.
- Completed: `pnpm --filter @chase-sets/design-system typecheck` passed.
- Completed: Browser visual verification with a temporary Tailwind-enabled design-system fixture confirmed the desktop active `Sell` dropdown shows the chevron. The real Marketplace route was attempted first but was blocked by a local `http://localhost:9603/api/auth` 502; no product behavior was changed.
- Not applicable: mobile does not render this desktop top-nav dropdown parent; the affected chevron state belongs to the desktop `TopNav` surface.

## Documentation To Promote

- No durable architecture or context documentation change is expected. The retained plan is sufficient because this is a small design-system regression fix.

## Goal Completion Criteria

- Implementation stays in the dedicated worktree and branch above.
- The plan remains committed with the implementation.
- Design-system regression tests pass.
- Typecheck passes for the design system or a broader equivalent command.
- Desktop visual verification confirms the dropdown arrow remains visible when the `Sell` trigger is active/open; mobile has no equivalent top-nav dropdown parent state.
- If publishing is requested later, submit a PR, verify CI passes, merge, deploy to staging, and confirm the staging Marketplace nav keeps the dropdown arrow.
