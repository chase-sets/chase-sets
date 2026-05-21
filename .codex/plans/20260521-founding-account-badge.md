# Founding Account Badge

## Intent

Give the first group of marketplace accounts a durable, account-owned Founding Account badge that can be assigned through Identity, displays beside account identity surfaces, and becomes a concrete waitlist incentive on the Public Presence landing page.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-founding-account-badge`
- Branch: `codex/founding-account-badge`
- Sandbox id: `9bd22605`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none currently known

## Owning Contexts

- Identity owns durable Account facts, account profile display, account API behavior, and account read models.
- Public Presence owns waitlist positioning, landing-page copy, and prelaunch conversion UI.
- The design-system `Badge` component remains the UI source of truth; the SVG is a slice-local visual asset for the Identity account badge.

## Resolved Decisions

- Canonical term: **Account Badge**. A Founding Account badge is one badge kind assigned to an Account, not a user role, seller tier, or waitlist signup state.
- Assignment model: add `AssignAccountBadge` and `RemoveAccountBadge` account commands, with `identity.account.badge-assigned` and `identity.account.badge-removed` events.
- Invariant: badge keys are unique per account and sorted for stable replay. Assigning an already assigned badge is idempotent; removing a missing badge is idempotent.
- Read model: add `badges jsonb NOT NULL DEFAULT '[]'::jsonb` to `identity_accounts` and project badge events into the account row.
- API: add account-scoped endpoints for assigning/removing badges under the existing accounts API, protected by `accounts.manage`.
- Display: show badges next to account names in the marketplace account profile and Identity admin account surfaces. The marketplace shell account menu stays unchanged because `identity/web` cannot export feature UI through the deployable-facing web surface.
- Public Presence copy: add Founding Account badge messaging to the waitlist page as an early-access reason, without implying waitlist signups are already accounts.
- Browser/server verification: the sandbox-aware `pnpm run dev:public-web` path is blocked because Docker Desktop is not running, so deployable builds and render tests are the current local verification substitute.

## Open Questions

- None. The first group size and operational criteria can remain outside code for now; this change gives staff the manual assignment mechanism.

## Implementation Checklist

- [x] Add Account Badge domain types, events, commands, projection, query shape, API endpoints, and tests.
- [x] Add a Founding Account SVG badge asset and account badge rendering component inside the Identity accounts UI slice.
- [x] Display account badges on marketplace account profile and admin account detail/list surfaces.
- [x] Update Public Presence landing-page copy and tests to make Founding Account status a waitlist incentive.
- [x] Run worktree dependency setup, sandbox doctor, focused tests, localization/structure checks, and relevant typecheck/build verification.

## Documentation To Promote

- Added Account Badge and Founding Account Badge terms to `bounded-contexts/identity/GLOSSARY.md`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
