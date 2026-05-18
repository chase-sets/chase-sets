# Mobile Admin Navigation

## Intent

Reduce mobile admin top navigation height so the active admin page starts near the top of the viewport while preserving fast access to section switching and sign-out.

The reported screenshot shows `/catalog/dimensions` on mobile with the browser chrome, then the admin top nav consuming a large vertical block: the `Catalog Ops` brand appears beside stacked full-size `Experience`, `Identity`, and `Sign Out` actions before page content begins.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-mobile-admin-nav`
- Branch: `codex/mobile-admin-nav`
- Base: local `main` at `e98c3101` (`main` was 23 commits behind `origin/main` when the worktree was created)
- Sandbox id: `5dcbde2b`
- Dependency setup status: installed with `pnpm run deps:install`
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: ordinary sandbox command execution failed with `CreateProcessAsUserW failed: 1312`; repo commands are continuing through approved escalated commands inside the isolated worktree
- Rebase status: branch rebased onto the latest `origin/main` before PR publishing.

## Owning Contexts

- Design system owns the reusable `AdminShell`, `TopNav`, `BottomNav`, responsive shell behavior, styling, and accessibility contract.
- Catalog owns the Catalog admin feature routes and Catalog shell composition, including `Catalog Ops` as the section brand and the primary nav items such as `Dimensions`.
- Identity owns identity-management admin routes and Identity shell composition.
- Experience owns platform feedback and waitlist review admin routes and Experience shell composition.
- `admin-web` is a thin composition root that wires context layouts and cross-section actions.

## Repo Evidence

- `bounded-contexts/README.md` says bounded contexts own UI and tests, while deployables compose behavior through stable boundaries.
- `docs/architecture/bounded-context-structure.md` says deployables own only host routes, layout, auth wiring, and runtime bootstrap; context route modules and shell contributions stay in bounded contexts, and reusable app shell behavior belongs in shared composition.
- `packages/design-system/README.md` says admin navigation uses bottom navigation on smaller screens and persistent side navigation at larger breakpoints. It also says admin apps should compose screens from exported design-system components only and not introduce app-owned CSS or one-off overrides.
- `packages/design-system/PANEL_INTERACTIONS.md` says mobile navigation should use tabs, bottom navigation, compact menu, or Navigation Drawer, with Navigation Drawer only for deep IA. It also says the design system owns responsive mapping, accessibility, motion, scrim behavior, and component API shape.
- `packages/design-system/src/patterns/app-shells.tsx` defines `AdminShell` as `TopNav` plus desktop `SideNav` plus mobile `BottomNav`. The `TopNav` receives `actions` directly, while primary nav items move to the bottom on mobile.
- `packages/design-system/src/components/actions/navigation.tsx` renders `TopNav` actions unchanged at all breakpoints and hides primary top nav items until `md`. It renders `BottomNav` fixed on mobile and horizontally scrollable when more than five items exist.
- `deployables/admin-web/app/routes/catalog-layout.tsx`, `identity-layout.tsx`, and `experience-layout.tsx` pass cross-section links plus sign-out as full `LinkButton`/`Button` actions. On mobile, those actions remain in the top nav and wrap into the oversized header.
- `bounded-contexts/catalog/context.json`, `identity/context.json`, and `experience/context.json` publish section-specific `primary-nav` contributions for admin routes; the screenshot bottom nav matches the Catalog contributions.

## Resolved Decisions

- Ownership: fix the reusable responsive shell behavior in `packages/design-system`, with minimal context/deployable wiring only if the existing action API cannot express the compact mobile behavior cleanly.
- Language: preserve existing context labels: `Catalog Ops`, `Identity Ops`, `Experience Ops`, `Dimensions`, `Fields`, `Components`, `Blueprints`, `Catalog`, `Identity`, `Experience`, and `Sign Out`.
- Invariants: no domain events, read models, APIs, schemas, or permissions change. This is presentation and navigation ergonomics only.
- Mobile behavior: the primary section nav remains bottom navigation because that is already the design-system default for admin on smaller screens.
- Mobile admin actions: collapse the top-right admin actions (`Catalog`/`Experience`/`Identity`/`Sign Out`) into one compact menu trigger while preserving access to every action.
- Desktop behavior: keep the existing visible cross-section actions in top nav unless the chosen mobile approach requires a backward-compatible action grouping API.
- Accessibility: the compact mobile control must be reachable by keyboard and screen readers, have an accessible name such as `Admin menu`, preserve at least 44px touch targets, and keep sign-out available without accidental activation.

## Open Questions

None.

## Implementation Checklist

- Install worktree dependencies with `pnpm run deps:install` or `node ./scripts/worktree-deps.mjs install`. Completed.
- Run `pnpm run sandbox:doctor`. Completed; sandbox id `5dcbde2b`.
- Add a design-system-supported compact mobile top-nav action surface, preferably inside `TopNav`/`AdminShell` rather than route-local CSS. Completed as an opt-in `TopNav` mobile actions menu, with `AdminShell` opting in via `mobileActionsLabel="Admin menu"` so non-admin `TopNav` callers remain unchanged.
- Keep desktop action rendering unchanged. Completed; desktop actions remain visible at `md` and up.
- Update admin shell tests to cover compact mobile action behavior, keyboard/accessibility labels, and retention of sign-out. Completed in design-system tests.
- Run focused typecheck/tests for design system and admin web. Completed after rebase: `pnpm --filter @chase-sets/design-system run test` passed with 106 tests, and `pnpm run verify:typecheck` passed.
- Verify `/catalog/dimensions` in mobile viewport with the in-app browser or Playwright screenshot. Completed with Playwright at 390x844 against local admin web before the opt-in refactor. Result: top nav height 69px, `Dimensions` heading top 113px, `Admin menu` present and opening to `Experience`, `Identity`, and `Sign Out`. Repeat smoke attempts after the opt-in refactor/rebase were blocked by local platform-api dev startup instability, but the refactor only moved the compact behavior behind an explicit `AdminShell` prop and was covered by tests plus repo typecheck.

## Documentation To Promote

- No durable domain documentation expected.
- If the design-system API adds a named action pattern, update `packages/design-system/README.md` or `PANEL_INTERACTIONS.md` only if the new behavior is a reusable pattern rather than an internal shell refinement.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
