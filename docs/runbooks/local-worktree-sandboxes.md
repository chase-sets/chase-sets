# Local Worktree Sandboxes

Chase Sets local development runs inside a worktree sandbox. A sandbox is the
runtime boundary for one Git worktree: Docker Compose project, containers,
volumes, Postgres host port, app ports, observability ports, generated runtime
env, Stripe webhook forwarding, and DB-backed test admin URL.

The sandbox id and port block are derived from the worktree path, so the same
worktree keeps stable URLs across restarts while different worktrees avoid the
fixed-port conflicts that came from one shared local stack.

## Add A Worktree

Create pooled sibling worktrees through the validated helper so malformed names
are rejected before Git runs:

```bash
pnpm run ops worktree:add <name> [branch]
```

## Inspect A Sandbox

```bash
pnpm run sandbox:doctor
```

The doctor output shows:

- sandbox id
- generated env file path
- Docker Compose project name
- app URLs
- Postgres admin and platform control URLs
- context database count
- observability URLs

Generated values are written to `.env.sandbox.local`. This file is ignored and
must not be synced into the machine-level shared env store.

## Start And Stop

```bash
pnpm run dev:bootstrap
pnpm run dev
```

`dev:bootstrap` starts this sandbox's Postgres container, provisions the
platform control database and per-context databases, and runs platform
bootstrap scripts with sandbox database URLs.

`pnpm run dev` runs the full local system for the current sandbox. Focused
targets are also sandbox-aware:

```bash
pnpm run dev:admin-web
pnpm run dev:marketplace
pnpm run dev:marketplace-full
pnpm run dev:public-web
pnpm run dev:platform-api
pnpm run dev:platform-worker
```

Stop only this worktree's Docker-backed services:

```bash
pnpm run dev:down
```

Remove this worktree's containers and volumes:

```bash
pnpm run sandbox:clean
```

Remove sandboxes whose worktree no longer exists. GC fails closed if the
registered-worktree inventory is unavailable or ambiguous, skips every project
with active containers, and re-inspects exact ownership immediately before
removal. It removes only stopped Compose projects and detached volumes or
networks carrying the generated worktree owner, sandbox ID, Compose project,
and matching Compose resource-kind labels:

```bash
pnpm run sandbox:gc
```

Remove every fully owned Chase Sets Compose project on the machine, including
active projects:

```bash
pnpm run sandbox:clean:all
```

Use all-sandbox cleanup only when no other local worktree should keep running; prefer `sandbox:gc` for routine reclamation.

The host-level Chase Sets sandbox GC automation runs `sandbox:gc` hourly while
the milestone orchestrator is active. Run the same command after any manual
worktree removal so Docker resources cannot outlive their owning worktree.

## Environment Model

Shared reusable secrets still live in the machine-level env home managed by:

```bash
pnpm run env:sync
pnpm run env:doctor
```

Sandbox runtime values live in `.env.sandbox.local`:

- canonical `CHASE_SETS_SANDBOX_WORKTREE` ownership identity
- `POSTGRES_DEV_ADMIN_DATABASE_URL`
- `POSTGRES_DEV_DATABASE_URL`
- `PLATFORM_CONTROL_DATABASE_URL`
- per-context `DATABASE_URL_<CONTEXT>`
- `TEST_DATABASE_URL`
- app ports and URLs
- Vite platform API target
- Stripe webhook forward URL
- observability ports and URLs

The split keeps secrets reusable while preventing generated ports and database
URLs from overwriting another worktree.

## DB-Backed Tests

DB-backed tests prefer `TEST_DATABASE_URL` from `.env.sandbox.local` unless the
shell already provides `TEST_DATABASE_URL`. This keeps local worktrees isolated
while still letting CI or one-off commands provide an explicit admin database.

```bash
pnpm run dev:bootstrap
pnpm run test:db
```

Each DB-backed test suite should continue using
`@chase-sets/bounded-context-runtime/test-support` so it creates owned,
per-context test databases from the sandbox admin URL.

## Database TLS Modes

Production-like database URLs should verify the server certificate with
`sslmode=verify-full` or `sslmode=verify-ca`. Provide a root CA bundle with the
connection-string `sslrootcert` parameter or the `PGSSLROOTCERT` environment
variable. `sslmode=require` is accepted only as an explicit loose mode for
local/dev connections that need encryption without certificate verification.
Plain local URLs such as `postgresql://localhost/...` remain non-TLS unless they
set an `sslmode`.

## Stripe Webhooks

The Stripe listener uses the sandbox platform API URL by default:

```bash
pnpm run stripe:listen
```

The listener stores the session `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` in
`.env.sandbox.local`. It does not push those session values to the shared env
store, so another worktree can run its own listener safely.

## Observability

Observability uses the same Compose project boundary as the rest of the
sandbox:

```bash
pnpm run dev:observability
pnpm run dev:observability:open
pnpm run dev:observability:down
```

Run `pnpm run sandbox:doctor` for the current Grafana, Prometheus, Loki, Tempo,
and OTLP URLs.

## Two-Worktree Verification

To verify isolation manually:

1. In worktree A, run `pnpm run sandbox:doctor` and note the sandbox id, ports,
   and Compose project.
2. In worktree B, run `pnpm run sandbox:doctor` and confirm the id, ports, and
   Compose project differ.
3. Run `pnpm run dev:bootstrap` in both worktrees.
4. Run `pnpm run test:db` in both worktrees, either sequentially or at the same
   time.
5. Start `pnpm run dev:marketplace-full` in one worktree and `pnpm run
   dev:public-web` in the other.
6. Use each doctor output to target the correct local URLs.
7. Run `pnpm run sandbox:clean` in one worktree and confirm the other worktree's
   Compose project and URLs continue working.

## Troubleshooting

If a port is already in use, choose another deterministic block:

```bash
set CHASE_SETS_SANDBOX_BASE_PORT=9400
pnpm run sandbox:doctor
```

On PowerShell:

```powershell
$env:CHASE_SETS_SANDBOX_BASE_PORT = "9400"
pnpm run sandbox:doctor
```

If Docker resources are stale, inspect projects with:

```bash
pnpm run sandbox:list
```

Then clean the current sandbox with `pnpm run sandbox:clean`, or all Chase Sets
sandboxes with `pnpm run sandbox:clean:all`.
