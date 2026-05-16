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

The Playwright config starts `pnpm run dev:marketplace-full` when the marketplace sandbox server is not already running. That command boots platform API, platform worker, and marketplace web for the current worktree.

Reports and failure artifacts are written under ignored `artifacts/playwright/` folders.
