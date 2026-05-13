# Worktree-Isolated Full-Stack Testing

## Intent

Enable multiple Chase Sets worktrees to run full local verification at the same time without conflicting on Postgres databases, Docker Compose project names, container names, volumes, app ports, Stripe webhook forwarding, observability ports, generated artifacts, or local env synchronization.

The target outcome is that each worktree can bootstrap, run DB-backed tests, run the platform API and worker, run one or more web deployables, smoke the stack, and tear itself down independently.

## Owning Contexts

This is cross-cutting developer infrastructure, not a business bounded context.

- `scripts/` owns local orchestration entry points such as `dev-system.mjs`, `worktree-deps.mjs`, `local-env.mjs`, `run-workspaces.mjs`, and smoke scripts.
- `infrastructure/` owns reusable technical adapters such as Postgres provisioning, platform runtime, event-store adapters, observability, and provider adapters.
- `deployables/` should stay thin and only consume environment-driven ports, URLs, and database settings.
- `docs/runbooks/` and `README.md` should own durable operator guidance.
- Bounded contexts should continue owning their own behavior, read models, seeds, tests, and test support usage.

## Resolved Decisions

- Use the term `worktree sandbox` for the isolated local runtime created for one Git worktree.
- Keep this out of business bounded contexts. The change belongs in scripts, reusable infrastructure helpers, and runbook documentation.
- Preserve the existing worktree dependency model: `scripts/worktree-deps.mjs` already shares a pnpm store while keeping per-worktree `node_modules`.
- Preserve context-owned DB test behavior. DB-backed tests already rely on `TEST_DATABASE_URL` as an admin connection and `@chase-sets/bounded-context-runtime/test-support` creates per-context owned test databases.
- Treat deployables as env consumers. `platform-api` and `platform-worker` already support `PORT`, `DATABASE_URL`, `PLATFORM_CONTROL_DATABASE_URL`, and per-context `DATABASE_URL_<CONTEXT>` variables.
- Prefer deterministic, discoverable defaults over random ports for long-running dev stacks, with an escape hatch for explicit overrides.
- Each worktree should get a full Docker-backed `worktree sandbox` by default, including its own Compose project, container names, volumes, Postgres host port, app port block, Stripe forwarding URL, observability ports, and scoped teardown.
- Sandbox identity and ports should be automatically derived from the worktree path, stable across restarts, and overrideable through explicit environment variables.
- Shared local env should keep reusable secrets. Generated sandbox runtime values should be written to an ignored per-worktree file and excluded from `env:sync`.
- Full-stack dev sandboxes should provision one platform control database plus per-context databases by default, with a temporary shared-database fallback only if implementation uncovers a transition blocker.
- Existing `dev:*` commands should become sandbox-aware by default, with explicit `sandbox:*` helpers for inspection, doctor output, stale sandbox cleanup, and optional global cleanup.

## Repo Evidence

- `docker-compose.dev.yml` currently fixes container names, host ports, and volume names such as `chase-sets-postgres-dev`, `5432:5432`, and `chase-sets-postgres-dev-data`.
- `scripts/dev-system.mjs` currently uses fixed default ports: portal `6170`, admin web `6172`, marketplace `6173`, public web `6174`, platform API `6182`, and platform worker `6183`.
- `scripts/dev-system.mjs` provisions one shared dev database named `chase_sets` by default.
- Root `.env.test.local` currently points DB-backed tests at `postgresql://postgres:postgres@localhost:5432/postgres`.
- `README.md` documents the single default local database and fixed default ports.
- `scripts/run-workspaces.mjs` already syncs local env and loads `.env.test.local` for test scripts, so test isolation can be introduced through generated env values rather than per-test shell ceremony.
- `infrastructure/bounded-context-runtime/test-support.ts` already creates uniquely named per-context test databases from an admin URL, which is good for concurrent DB tests once the admin database itself is unambiguous for each sandbox.
- `scripts/stripe-cli.mjs` has a fixed default webhook forward URL to the platform API port, so full-stack Stripe testing also needs sandbox-aware URL resolution.
- Vite configs for web deployables currently proxy to `http://localhost:6182`, so web/API isolation needs the API target to become env-driven or generated per sandbox.

## Open Questions

None for the first implementation pass.

## Implementation Checklist

- Add `scripts/lib/sandbox.mjs` or equivalent to resolve:
  - stable sandbox id from worktree path
  - explicit `CHASE_SETS_SANDBOX_ID` override
  - deterministic port block with explicit per-surface overrides
  - Compose project name, container names, volume names, and network names
  - generated per-worktree env file path
- Add sandbox-aware env generation for:
  - `POSTGRES_DEV_ADMIN_DATABASE_URL`
  - `POSTGRES_DEV_DATABASE_NAME`
  - `POSTGRES_DEV_DATABASE_URL`
  - `PLATFORM_CONTROL_DATABASE_URL`
  - per-context `DATABASE_URL_<CONTEXT>` values
  - `TEST_DATABASE_URL`
  - platform API, worker, web, portal, Stripe forward, and observability URLs
- Update `docker-compose.dev.yml` to remove singleton container/volume assumptions and consume sandbox names/ports from generated env.
- Teach `dev-system.mjs` lifecycle commands to operate on the current sandbox only:
  - `dev`
  - `dev:bootstrap`
  - `dev:down`
  - `dev:db:refresh`
  - focused targets such as `dev:admin-web`, `dev:marketplace-full`, and `dev:public-web`
- Add `sandbox:*` helpers for doctor output, current sandbox env printing, stale sandbox listing, current sandbox cleanup, and explicit all-sandbox cleanup.
- Update Vite proxy config and dev portal URLs to consume sandbox-aware API/web port values.
- Update `scripts/run-workspaces.mjs` test environment loading so DB-profile tests prefer the generated sandbox `TEST_DATABASE_URL` while preserving shared secrets.
- Update `scripts/stripe-cli.mjs` so webhook forwarding targets the sandbox platform API URL by default.
- Update platform smoke command guidance so smoke URLs can be read from the sandbox env or doctor output.
- Add script tests for sandbox id stability, collision behavior, port allocation, env generation, Compose naming, current-sandbox teardown, and all-sandbox cleanup safeguards.
- Add a two-worktree manual verification script or runbook procedure that starts two full stacks and confirms isolated DBs, ports, containers, volumes, Stripe forward URLs, and smoke targets.
- Add runbook coverage for running two worktrees side by side, refreshing one sandbox, DB-profile test isolation, smoke testing, and cleaning stale sandboxes.

## Documentation To Promote

- `README.md`: quick-start commands and the mental model for independent worktree sandboxes.
- `docs/runbooks/local-worktree-sandboxes.md`: full lifecycle, conflict diagnosis, env overrides, cleanup, and examples for two simultaneous worktrees.
- `docs/README.md`: link the new runbook in the curated map.

## Goal Completion Criteria

- Implementation keeps deployables as thin environment-driven composition roots.
- Full dev stack can run in two worktrees simultaneously with isolated databases, ports, containers, volumes, and provider forwarding.
- DB-backed tests can run concurrently from two worktrees without database or role collisions.
- Platform smoke can target a sandbox-specific URL set.
- Documentation is promoted to README and a local worktree sandbox runbook.
- Automated checks cover the new script behavior.
- A later implementation goal retains this plan file, submits a PR, gets CI green, merges, verifies staging deployment remains unaffected, and confirms no product behavior changed unintentionally.
