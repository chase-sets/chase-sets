# Playwright E2E Critical Flows

## Intent
Install Playwright through the official `@playwright/test` package and add a first browser-level e2e suite for the highest-risk marketplace journeys. The suite should prove the composed marketplace web deployable can render and navigate critical context-owned routes while keeping behavior ownership inside bounded contexts.

## Worktree
- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260516-playwright-e2e-critical-flows`
- Branch: `codex/playwright-e2e-critical-flows`
- Sandbox id: `55efb8ba`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found; sandbox ports start at base `8900`

## Owning Contexts
- Auth owns sign-in, registration, session cookie behavior, account selection, and safe return paths.
- Discovery owns browse/search, result presentation, item-detail, public listing, and public seller route behavior.
- Checkout owns account cart and checkout session route behavior.
- Marketplace owns account listings, offer matches, submitted offers, and listing/offer workflows.
- Deployables remain thin composition roots; e2e tests will verify marketplace-web composition, not introduce feature behavior in the deployable.

## Resolved Decisions
- Place Playwright orchestration at the repo root (`playwright.config.ts`) and marketplace composition specs under `deployables/marketplace/e2e` because these tests span multiple bounded contexts through the composed marketplace deployable.
- Keep test assertions at route/navigation and user-critical affordance level. Domain behavior remains covered by context-owned unit, route, and acceptance tests.
- Use the local worktree sandbox URLs from `scripts/lib/sandbox.mjs` so e2e runs do not collide with other worktrees.
- Start the full marketplace dev stack for e2e by default (`platform-api`, `platform-worker`, and `marketplace`) because checkout, auth, and marketplace pages depend on API composition and seeded state.
- Keep Playwright reports and results under ignored `artifacts/playwright/`.
- Structure check rejected top-level `e2e/`, `playwright-report/`, and `test-results/`. Specs now live under `deployables/marketplace/e2e` as deployable-composition tests, and Playwright output goes under ignored `artifacts/playwright/`.

## Open Questions
- None blocking. The initial critical-flow scope is inferable from context ownership and existing route coverage.

## Implementation Checklist
- [x] Install `@playwright/test` as a dev dependency using pnpm so `pnpm-lock.yaml` records the official package.
- [x] Add root Playwright config with sandbox-derived base URL, web server startup, trace/screenshot/video defaults, and CI-friendly retries/workers.
- [x] Add critical-flow specs for signed-out marketplace discovery/auth navigation, seeded marketplace commerce navigation, and account route auth protection.
- [x] Add root scripts for e2e install/run and include a non-default verification command that does not bloat the fast unit loop.
- [x] Add concise e2e README/runbook notes for browser install and sandbox behavior.
- [x] Run dependency setup, sandbox doctor, Playwright install, targeted e2e, structure, metadata, and type checks.

## Documentation To Promote
- Added `docs/runbooks/playwright-e2e.md`.
- Updated `docs/README.md`.

## Verification
- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `55efb8ba`.
- `pnpm exec playwright install chromium` passed.
- `pnpm run test:e2e` passed: 3 marketplace critical-flow tests.
- `pnpm run verify:metadata` passed.
- `pnpm run check:structure` passed after moving specs/output to structure-compliant paths.
- `pnpm run typecheck` passed.
- `pnpm exec playwright --version` reports `Version 1.60.0`.

## Goal Completion Criteria
- `@playwright/test` is installed and locked.
- E2E scripts are available from the repo root.
- Critical marketplace flows have browser-level coverage.
- Tests use sandbox-aware local URLs and do not require hard-coded ports.
- Verification results are recorded before handoff.
