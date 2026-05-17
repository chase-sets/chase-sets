# CI Run Playwright E2E Plan

Date: 2026-05-17
Worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-ci-run-playwright-e2e`
Branch: `codex/ci-run-playwright-e2e`

## Request

Update CI so the official Playwright marketplace e2e tests run as part of pull request and main validation.

## Evidence

- `bounded-contexts/README.md` keeps deployables thin and assigns behavior to bounded contexts.
- `docs/architecture/bounded-context-structure.md` keeps tests and UI behavior with the owning context while deployables compose them.
- `bounded-contexts/auth/README.md` owns sign-in, registration, session cookies, and return paths.
- `bounded-contexts/discovery/README.md` owns browse and search experiences.
- `bounded-contexts/checkout/README.md` owns cart intent and active purchase workflows.
- `bounded-contexts/marketplace/README.md` owns listing and offer interaction before an order exists.
- `deployables/marketplace/e2e/critical-flows.spec.ts` currently verifies signed-out search/auth entry points, protected route return-path preservation, and seeded account access to cart and seller listings.
- `playwright.config.ts` uses the official Playwright runner, starts `pnpm run dev:marketplace-full`, writes reports under `artifacts/playwright/`, and runs Chromium in CI with retries and one worker.
- `.github/workflows/platform-pr.yml` has separate validation jobs and a `PR Required` aggregate gate for branch protection and deployment workflow handoff.

## Decisions

1. Add a dedicated `e2e-tests` job to `.github/workflows/platform-pr.yml` instead of folding browser tests into static, unit, or build jobs.
2. Use the existing pnpm setup action and frozen install pattern for consistency with other CI jobs.
3. Install the Chromium browser plus Linux system dependencies in CI with `pnpm exec playwright install --with-deps chromium`.
4. Run `pnpm run test:e2e`; the existing Playwright config owns server startup and sandbox-aware URLs.
5. Upload Playwright reports and failure artifacts when the job fails so CI failures have traces, screenshots, videos, and the HTML report.
6. Add `e2e-tests` to the `PR Required` needs list and required-result loop.
7. Update the Playwright and deployment runbooks so the CI contract is durable.

## Implementation Scope

- `.github/workflows/platform-pr.yml`
- `deployables/marketplace/e2e/critical-flows.spec.ts`
- `docs/runbooks/playwright-e2e.md`
- `docs/runbooks/digitalocean-platform-deployment.md`

The e2e test update follows the current Auth two-step sign-in journey so CI can run the existing critical-flow coverage. No product runtime behavior, route behavior, or bounded-context implementation changes are planned.

## Verification

1. `pnpm run deps:install`
2. `pnpm run sandbox:doctor`
3. `pnpm exec playwright install chromium`
4. `pnpm run test:e2e`
5. `pnpm run verify:static`

## Verification Results

- `pnpm run deps:install` passed. The existing cyclic workspace dependency warning was emitted during install.
- `pnpm run sandbox:doctor` passed for sandbox `22533a92` on port base `7500`.
- `pnpm exec playwright install chromium` passed.
- `pnpm run test:e2e` passed with 3 marketplace critical-flow tests.
- `pnpm run verify:static` passed.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color` passed.
- `git diff --check` passed.

## Open Questions

None. The request is operational workflow work and the existing `PR Required` gate establishes where the new check belongs.
