# Simplify Account Menu

## Intent

Simplify the signed-in marketplace shell header so normal users see one clear account control instead of separate "Acting as", "Signed in as", Account dropdown, and Sign Out elements.

The experience should make the current account, current user, and membership role visible without domain-heavy phrasing, and it must work cleanly on desktop and mobile.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-simplify-account-menu`
- Branch: `codex/simplify-account-menu`
- Base: current source repo `HEAD` at worktree creation, commit `8cc4f1e6`
- Sandbox id: `9f3b05b1`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox status: `pnpm run sandbox:doctor` completed successfully.
- Marketplace dev URL for implementation verification: `http://localhost:7453`
- Setup caveats: source repo `main` was behind `origin/main` by 2 commits when the planning worktree was created; no user changes were present in source repo status output.

## Owning Contexts

- Identity owns the User, Account, Membership, Role, and the current actor display facts shown in the shell.
- Auth owns sign-out behavior and the `/sign-out` route.
- Notifications owns the Notification Center shell utility and should stay a separate utility action.
- Checkout owns Cart and cart count; it should stay a separate utility action.
- Marketplace deployable route composition currently assembles Identity display facts, Auth sign-out, Notifications shell, and host nav into the marketplace shell.
- Design System owns the canonical shell/nav/menu primitives and should receive any reusable account-menu component instead of adding custom marketplace-only styling.

## Repo Evidence

- `bounded-contexts/README.md` says Identity is upstream for user/account references and Auth is upstream for browser authentication journeys and actor resolution.
- `bounded-contexts/identity/GLOSSARY.md` says accounts do not sign in; users sign in; Membership links a User to an Account and records Role.
- `bounded-contexts/auth/README.md` says Auth owns sign-in, sign-out, browser session lifecycle, and actor-resolution helpers.
- `bounded-contexts/notifications/README.md` says the marketplace Notification Center is a shell drawer or sheet, not a primary full-page account destination.
- `deployables/marketplace/app/routes/layout.tsx` currently renders `ActorIdentityCue` and a separate `/sign-out` form in shell actions while top navigation separately includes an Account dropdown.
- `packages/design-system/src/components/data-display/actor-identity-cue.tsx` uses the labels that caused confusion in the shell variant.
- `packages/design-system/src/components/actions/navigation.tsx` supports top-nav dropdown children but bottom navigation ignores children and uses primary item links/buttons.
- `deployables/marketplace/app/routes/layout.test.tsx` asserts the current duplicate shell pieces, including `action="/sign-out"`, "Acting as", and "Signed in as".

## Resolved Decisions

- Avoid the labels "Acting as" and "Signed in as" in the marketplace shell header. They are accurate but too internal for normal marketplace users.
- Use canonical Identity terms in visible text: Account, User, Membership, and Role where a label is needed.
- Keep Notifications and Cart as standalone utility actions because they are frequent destination/action surfaces with independent state.
- Do not move sign-out ownership out of Auth; only change how the marketplace shell exposes the existing sign-out action.
- Do not introduce deployable-local custom component styling. Add or reuse design-system primitives for any new account menu/control.
- Replace the desktop Account top-nav dropdown with one combined account menu in shell actions. The closed control shows account and role; the opened menu shows user identity, account links, and Sign out as the final action. Keep mobile bottom-nav Account as a navigation shortcut and expose the compact account menu in the mobile top bar.

## Open Questions

None.

## Implementation Checklist

- [x] Add a design-system account menu/control or extend an existing primitive so the marketplace shell can render account identity, account links, and sign-out as one control.
- [x] Update marketplace shell composition to pass account menu actions instead of separate `ActorIdentityCue` and Sign Out button.
- [x] Remove or suppress the desktop top-nav Account dropdown when the account menu owns account destinations.
- [x] Preserve mobile Account bottom-nav access while ensuring sign out and identity context are reachable from the mobile top bar.
- [x] Update localization keys to remove shell use of "Acting as" and "Signed in as" while preserving existing panel/profile language where still appropriate.
- [x] Update tests covering signed-in desktop nav, signed-in mobile-relevant markup, sign-out presence, account/user/role display, cart visibility, and notification behavior.
- [x] Run focused tests for marketplace layout and design-system component behavior.
- [x] Run typecheck/static checks that cover changed packages.
- [x] Start the marketplace dev server and verify desktop and mobile screenshots with the in-app browser after implementation.

## Documentation To Promote

- No durable ADR expected. This is a reversible shell UX simplification using existing context ownership.
- If a reusable account-menu component is added to the design system, update design-system docs or component tests as the durable source of truth.
- If new product language is introduced beyond Account/User/Membership/Role, update `bounded-contexts/identity/GLOSSARY.md` first and then `docs/GLOSSARY.md` if the term crosses contexts.

## Goal Completion Criteria

The implementation goal must:

- Implement in this worktree and branch.
- Preserve Identity ownership of account/user/membership display facts and Auth ownership of sign out.
- Promote any durable design-system documentation/tests required for the new account menu pattern.
- Verify desktop and mobile UX visually through the in-app browser.
- Run focused automated tests plus relevant static/type checks.
- Submit a PR from `codex/simplify-account-menu`.
- Get CI passing, merge the PR, verify staging deploy behavior, and retain this plan file with the implementation for review.

## Implementation Verification

- `pnpm --filter @chase-sets/design-system run test`: passed, 82 tests.
- `pnpm --filter @chase-sets/app-marketplace-web run test`: passed, 80 tests after implementation.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm --filter @chase-sets/app-marketplace-web run typecheck`: passed.
- `pnpm run check:localization`: passed for 372 source files.
- `pnpm run check:no-any`: passed.
- Browser desktop verification at `http://localhost:7453/account`: signed-in shell shows one account menu control with account `Chase Sets` and role `Owner`; Notifications and Cart remain separate utilities; desktop Account top-nav dropdown is absent; opened account menu shows User `Demo Account`, account links, and Sign Out.
- Browser mobile verification at 390x844: top bar keeps the compact account menu; bottom nav keeps Browse, Cart, Notifications, Sell, and Wallet; opened account menu fits the viewport and exposes account links plus Sign Out.

## Implementation Goal Prompt

Implement the simplified account menu in `D:\Users\ToddS\Source\Repos\chase-sets-20260513-simplify-account-menu` on branch `codex/simplify-account-menu`, following `.codex/plans/20260513-simplify-account-menu.md`.

Replace the marketplace desktop Account top-nav dropdown plus separate actor cue plus separate Sign Out button with one combined design-system-backed account menu in shell actions. The closed menu control should show the selected account and membership role in user-friendly language; the opened menu should show the user name/email, account navigation links, and Sign out as the final action. Preserve Notifications and Cart as separate utilities. Preserve mobile bottom-nav Account navigation while making identity context and Sign out reachable from the mobile top bar. Keep Identity as owner of account/user/membership display facts, Auth as owner of sign-out behavior, Notifications as owner of notification drawer behavior, and Checkout as owner of cart state.

Promote any durable design-system documentation/tests needed for the account menu pattern. Verify with focused automated tests, relevant static/type checks, and in-app browser desktop/mobile visual checks against the marketplace dev URL for sandbox `9f3b05b1`. Submit a PR, get CI passing, merge it, verify staging deploy behavior, and keep this plan file committed with the implementation.
