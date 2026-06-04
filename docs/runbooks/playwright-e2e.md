# Playwright E2E

Browser e2e tests use the official Playwright test runner and the worktree sandbox ports.

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

## Deployed Targets

Playwright can run against an already deployed marketplace without starting the local sandbox server:

```bash
PLAYWRIGHT_SKIP_WEB_SERVER=true \
ADMIN_WEB_URL=https://admin.staging.chasesets.com \
MARKETPLACE_WEB_URL=https://marketplace.staging.chasesets.com \
CATALOG_ADMIN_E2E_EMAIL=admin@example.com \
CATALOG_ADMIN_E2E_PASSWORD=... \
pnpm run test:e2e:deployed
```

Use `MARKETPLACE_E2E_EMAIL`, `MARKETPLACE_E2E_PASSWORD`, and `MARKETPLACE_E2E_SEARCH_QUERY` to override the default synthetic account and search term. When no account is configured, the suite registers a throwaway account against the target before checking signed-in commerce surfaces.

Deployed admin-web suites run only when `ADMIN_WEB_URL`, `CATALOG_ADMIN_E2E_EMAIL`, and `CATALOG_ADMIN_E2E_PASSWORD` are all set. When admin credentials are absent, `pnpm run test:e2e:deployed` keeps the deployed smoke to marketplace projects even if `ADMIN_WEB_URL` is present. Staging production promotion runs this mode after staging smoke checks and before production deployment can start.

## CI

The Platform PR workflow runs `E2E Tests` as a required job before `PR Required` can pass. CI installs Chromium and Linux browser dependencies with:

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
