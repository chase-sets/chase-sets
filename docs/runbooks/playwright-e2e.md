# Playwright E2E

Browser e2e tests use the official Playwright test runner and the worktree sandbox ports.

## Charter

The Playwright e2e layer exists to catch composition and wiring failures that only surface in a real browser against the assembled deployable -- server-side rendering, hydration, redirect chains, cross-context route handoffs, and the payment iframe handoff -- and not to re-test domain logic that the vitest unit, route, and acceptance suites already own; concretely, the browser suites assert that decomposed and critical routes mount, authenticate, redirect, and recover (rendering their recovery surfaces instead of the root error boundary) when SSR composes cross-context loaders, while the depth of checkout fee math, payment capture, sell-list readiness, and claim-token lifecycles stays with the vitest suites, so e2e specs are added only where launch risk lives in the composition seam (auth gates, readiness redirect chains, confirmation-surface error boundaries, guest claim entry points) and are kept in the change-scope-gated CI lane with no always-on browser matrix.

## Suite coverage

The lane runs by tag (`scripts/e2e-suites.mjs` maps each suite id to a `@tag`; `scripts/run-e2e-suite.mjs` invokes `playwright test --grep`). Playwright auto-discovers any spec under each deployable's `e2e/**/*.spec.ts` via `testMatch`, so a new spec joins the lane purely by carrying an existing suite tag -- no config change. Change-scope selection (`e2eSuiteIdsForChangedFile`) decides _whether_ e2e runs and _which_ suites, keyed off route-file globs.

- `marketplace_browse` (`@marketplace-browse`): search/browse and the decomposed `items/:id` item-detail route + commerce panel.
- `marketplace_account` (`@marketplace-account`): authenticated account-area access and return-path preservation.
- `marketplace_checkout` (`@marketplace-checkout`): buy/sell checkout recovery, the decomposed `checkout/sell/session/:sessionId` sell handoff + readiness redirect chain, and the decomposed `account/payments/:paymentId` / `checkout/payments/:paymentId` payment confirmation and guest-claim surfaces.
- `marketplace_seller` (`@marketplace-seller`): listings, offers, and seller operations.
- `catalog_admin_integrations` (`@catalog-admin-integrations`): the admin-web catalog integration workbench.
- `catalog_admin_modeling` (`@catalog-admin-modeling`): the admin-web catalog model authoring surfaces, including Dimensions list/detail navigation and create-dialog affordances.

## Local Setup

```powershell
pnpm run deps:install
pnpm run sandbox:doctor
pnpm run test:e2e:install
```

## Run

```powershell
pnpm run test:e2e
```

The Playwright config starts `pnpm run dev:browser-e2e` when the sandbox server is not already running. That command boots platform API, platform worker, admin web, and marketplace web for the current worktree.

Run one or more named suites with a comma-separated list:

```powershell
pnpm run test:e2e:suite marketplace_browse,marketplace_account
```

Admin suites are selected the same way:

```powershell
pnpm run test:e2e:suite catalog_admin_integrations
```

Reports and failure artifacts are written under ignored `artifacts/playwright/` folders.

## Responsive evidence

Screenshot-backed responsive claims are registered in
`infrastructure/playwright-evidence/responsive-evidence-manifest.json` and captured only through
`captureResponsiveEvidence`. The contract sets the registered viewport, verifies
the exact route, requires one visible target with populated target-relative
children, executes the registered layout measurements, and writes paired
screenshot and runtime-manifest attachments. The closed runtime manifest binds
the exact claim, route, fixture, viewport, target, screenshot path/digest,
source-claim digest, and Playwright-config digest. It does not declare a trace
unless the configured successful run produces and binds one.

The structure check applies only to manifest-designated claims. It rejects
optional locator-count or visibility gates, swallowed assertion failures, and
direct screenshots in those tests; ordinary conditional Playwright behavior
outside designated evidence remains valid.

After a complete suite run, artifact validation rejects missing, stale,
substituted, duplicate, cross-claim, and unknown-field payloads. PR CI retains
the report and test-results directories for successful as well as failed E2E
jobs.

## Deployed Targets

Playwright can run against an already deployed marketplace without starting the local sandbox server:

```bash
PLAYWRIGHT_SKIP_WEB_SERVER=true \
ADMIN_WEB_URL=https://admin.staging.chasesets.com \
CATALOG_ADMIN_E2E_EMAIL=admin@example.com \
CATALOG_ADMIN_E2E_PASSWORD=... \
MARKETPLACE_WEB_URL=https://marketplace.staging.chasesets.com \
pnpm run test:e2e:deployed
```

Use `MARKETPLACE_E2E_EMAIL`, `MARKETPLACE_E2E_PASSWORD`, and `MARKETPLACE_E2E_SEARCH_QUERY` to override the default synthetic account and search term. When no account is configured, the suite registers a throwaway account against the target before checking signed-in commerce surfaces. Use `CATALOG_ADMIN_E2E_EMAIL` and `CATALOG_ADMIN_E2E_PASSWORD` when running admin-web suites against a deployed target; deployed admin-web checks are skipped when either admin credential is missing. Staging production promotion runs this mode after staging smoke checks and before production deployment can start.

## CI

The Platform PR workflow runs `E2E Tests` as a required full-battery job before `PR Required` can pass on merge-group runs and on pull requests labeled `full-ci`, `full-pr-battery`, or `preview`. CI installs Chromium and Linux browser dependencies with:

```bash
pnpm exec playwright install --with-deps chromium
```

The job then runs:

```bash
pnpm run test:e2e:suite "$E2E_SUITES"
```

The selected suite list comes from change-scope metadata. CI runs those suites in one Playwright invocation so Chromium installation and the marketplace sandbox boot happen once per PR job.

On failure, CI uploads `artifacts/playwright/report` and `artifacts/playwright/test-results` as `playwright-e2e-artifacts`.

The production deployment workflow also installs Chromium in the staging job and uploads `staging-playwright-critical-flow-artifacts` if staging critical flows fail.
