# Staging Critical Flow Gate

## Intent

Prevent production promotion when the staging release cannot prove critical marketplace behavior still works.

The gate should cover the launch-facing marketplace surfaces and account commerce workflows called out by the request: sign-in, search, listing/selling navigation, offer navigation, buying/cart navigation, payment readiness, and payout readiness. It should run after staging deploys and before production promotion.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-staging-critical-flow-gate`
- Branch: `codex/staging-critical-flow-gate`
- Sandbox id: `095d9471`
- Dependency setup status: complete
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Auth owns sign-in, registration, sessions, and return-path behavior.
- Discovery owns browse/search and item detail discovery surfaces.
- Marketplace owns listings, submitted offers, and offer matches.
- Checkout owns Buy Cart, Sell List, and checkout session intent.
- Inventory owns account inventory stock and storage workflows used by selling.
- Ordering owns Purchases and Sales projections for committed orders.
- Payments owns Payment and provider/payment readiness.
- Settlement owns Wallet, payout readiness, and Payouts.
- Deployment workflows and runbooks own the production promotion gate.

## Resolved Decisions

- Production promotion should continue to depend on the existing staging deploy job, but staging must now run a critical-flow browser/API gate before it marks itself deployable.
- Playwright should be able to target a deployed marketplace URL without starting the local sandbox web server.
- The existing marketplace Playwright suite should broaden from minimal auth/search/cart/listings coverage to route-level smoke coverage for the critical account surfaces across the owning bounded contexts.
- Stripe money smoke should run in staging before production promotion because Playwright should not handle raw payment or payout provider details. This reuses the provider-safe API smoke path documented in Money Operations.
- Staging critical-flow checks should use test-mode credentials and synthetic or seeded accounts only; production data, raw provider payloads, payment details, and payout destination details remain out of test artifacts.

## Open Questions

- None blocking. Staging secrets already carry platform admin, Stripe, and Connect configuration for smoke checks. The browser suite can use the seeded `demo@chasesets.test` account unless explicit `MARKETPLACE_E2E_EMAIL` and `MARKETPLACE_E2E_PASSWORD` are supplied.

## Implementation Checklist

- [x] Make Playwright skip the local web server when running against an already deployed target.
- [x] Add a staging-safe Playwright script entrypoint.
- [x] Expand marketplace critical-flow Playwright coverage for signed-in account commerce route reachability.
- [x] Add staging Playwright and Stripe money smoke checks to the production workflow before `Mark staging deployed`.
- [x] Update deployment and Playwright runbooks to document the new gate.
- [x] Add/update workflow guard tests so the staging critical-flow gate does not regress silently.
- [x] Install worktree dependencies and run focused verification.

## Documentation To Promote

- `docs/runbooks/playwright-e2e.md`
- `docs/runbooks/digitalocean-platform-deployment.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
