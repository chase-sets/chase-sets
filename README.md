# Chase Sets

Chase Sets is a trading card and collectibles marketplace built for high-volume, low-value commerce. The platform is designed to make buying and selling fair, efficient, and transparent while protecting seller margins through predictable fees, efficient workflows, and scalable marketplace operations.

The codebase is a TypeScript monorepo organized around bounded contexts, event-sourced domain behavior, event-driven integration, and thin deployable composition roots.

## Product Direction

Chase Sets prioritizes:

- Competitive product pricing and transparent marketplace economics.
- Efficient buying workflows for collectors, players, bulk buyers, and resellers.
- Seller workflows that support bulk inventory, low-friction fulfillment, repricing, and better low-value card margins.
- A scalable catalog and listing model where downstream commerce references resolved products, not ambiguous labels.
- Natural language that matches both internal implementation and external product surfaces.

Start with [docs/PRODUCT.md](docs/PRODUCT.md) for the product brief and [docs/GLOSSARY.md](docs/GLOSSARY.md) for marketplace language.

## Architecture Principles

- Bounded contexts own behavior, read models, UI, tests, and ubiquitous language.
- Deployables are thin composition roots. Business behavior should not live in deployables.
- Vertical slices are preferred over layered sprawl.
- Shared code stays tiny and explicit. Code used by one slice belongs in that slice.
- Cross-context contracts belong in `contracts/`; provider and runtime implementations belong in `infrastructure/`.
- Domain behavior favors clear event-sourced state transitions, functional patterns, composition, and single responsibility.
- The design system is the canonical source of truth for UI components and patterns. Application code should compose exported design-system components without custom overrides.

Breaking changes are welcome when they reduce entropy and make the model clearer.

## Repository Map

```text
bounded-contexts/      Domain contexts with features, routes, read models, UI, tests, and local support code.
contracts/             Stable cross-context contracts and primitives.
deployables/           Thin runnable applications and services.
docs/                  Cross-cutting product, language, runbooks, ADRs, and API documentation.
infrastructure/        Runtime adapters, persistence, observability, provider integrations, and test providers.
packages/design-system Canonical React UI system, tokens, primitives, shells, and shared patterns.
scripts/               Workspace automation, verification, dev system, replay, structure, and provider tooling.
artifacts/             Generated local logs, screenshots, observability output, and structure metrics.
```

## Bounded Contexts

Each context has its own `README.md` and `GLOSSARY.md` where useful. Treat those files as the local source of truth before editing behavior.

- `auth`: sign-in, registration, account selection, sign-out, and session behavior.
- `catalog`: canonical catalog item, product resolution, dimensions, options, fields, components, blueprints, and categories.
- `checkout`: cart intent and active checkout workflow before payment.
- `commercial-terms`: seller-side marketplace fee policy and confirmed fee snapshots.
- `discovery`: browse, search, detail, filters, facets, and relevance behavior.
- `fulfillment`: ship-from locations, shipments, packages, and shipping method selection.
- `identity`: users, accounts, memberships, and roles.
- `insights`: analytical projections, dashboards, metrics, and forecasting views.
- `inventory`: account-held stock, storage, availability, and resolved product inventory.
- `marketplace`: listings, offers, product-scoped supply, and product-scoped demand before orders exist.
- `ordering`: buyer and seller commercial commitments after checkout creates orders.
- `payments`: external charge, authorization, capture, refund, and payment processor references.
- `pricing`: product-scoped value estimation, repricing intelligence, and liquidity modeling.
- `public-presence`: public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.
- `reputation`: post-transaction reviews, ratings, feedback, and account review summaries.
- `settlement`: ledger truth, balances, wallets, payouts, fees, and rebates.
- `tax`: provider-agnostic tax quotes and order tax snapshots.

## Deployables

- `deployables/marketplace`: buyer and seller marketplace web app.
- `deployables/admin-web`: internal admin web app.
- `deployables/platform-api`: Hono-based platform API and HTTP composition root.
- `deployables/platform-worker`: background worker composition root.

Default local ports are sandbox-aware. Each worktree receives a stable
port block derived from its path so multiple worktrees can run at the same
time. Use `pnpm run sandbox:doctor` to print the current worktree's URLs.
The fallback ports below are still used when running deployables directly
without the sandbox env:

| Surface | URL |
| --- | --- |
| Dev portal | <http://localhost:6170> |
| Admin web | <http://localhost:6172> |
| Marketplace web | <http://localhost:6173> |
| Platform API | <http://localhost:6182> |
| Platform worker | <http://localhost:6183> |

## Prerequisites

- Node.js 26.1.0.
- pnpm 11.0.9. Run `npm install -g pnpm@11.0.9` if it is not already available.
- Docker with Docker Compose.
- Optional: Stripe CLI for webhook-driven payment smoke tests.

CI runs on Node 26.1.0 and uses `pnpm install --frozen-lockfile`, so local development should do the same when starting from a fresh checkout. Worktrees share a pnpm content store at `../.chase-sets-pnpm-store` by default; set `CHASE_SETS_PNPM_STORE_DIR` to override it.

## Getting Started

```bash
pnpm run setup:worktree
pnpm run dev:bootstrap
pnpm run dev
```

`pnpm run dev` creates or refreshes the current worktree sandbox, starts its
Docker-scoped Postgres, provisions the platform control database and
per-context databases, bootstraps platform services, and runs the full local
system.

Inspect the active sandbox:

```bash
pnpm run sandbox:doctor
```

Focused dev targets are available when you only need part of the system:

```bash
pnpm run dev:admin-web
pnpm run dev:marketplace-full
```

Useful local lifecycle commands:

```bash
pnpm run dev:down       # stop this worktree sandbox
pnpm run dev:db:refresh # destroy this sandbox Postgres data and bootstrap again
pnpm run sandbox:clean  # remove this worktree sandbox containers and volumes
```

The sandbox writes generated runtime values to `.env.sandbox.local`. That file
is ignored and local to the worktree. Platform environment defaults live in:

- [deployables/platform-api/.env.example](deployables/platform-api/.env.example)
- [deployables/platform-worker/.env.example](deployables/platform-worker/.env.example)

Stripe and EasyPost are optional for local startup. When Stripe configuration is missing, platform payment flows use the fake payment processor.

### Local Environment Files

Ignored local env files are synchronized from a machine-level shared directory so each worktree can hydrate the same local secrets and variables. The default shared location is:

```bash
%USERPROFILE%\.config\chase-sets\env\local
```

Set `CHASE_SETS_LOCAL_ENV_HOME` to use a different shared directory.

The shared directory mirrors repo-relative env paths, such as:

- `.env.test.local`
- `deployables/platform-api/.env.local`

Useful commands:

```bash
pnpm run env:sync   # two-way sync; newer file wins
pnpm run env:pull   # copy shared env into this worktree
pnpm run env:push   # copy this worktree env into shared env
pnpm run env:check  # report missing or drifted env files
pnpm run env:doctor # print detailed local env status
```

`pnpm run dev`, `pnpm run dev:bootstrap`, and `pnpm run dev:db:refresh` run `env:sync` before starting the local platform. Test workspace runs hydrate local test env before reading `.env.test.local`, then prefer generated sandbox runtime values from `.env.sandbox.local` unless the shell already provided a value. The Stripe listener stores its session webhook secret in `.env.sandbox.local` so simultaneous worktrees do not overwrite each other.

## Common Commands

```bash
pnpm run typecheck
pnpm run test
pnpm run test:db
pnpm run build
pnpm run verify
```

The main verification path is:

```bash
pnpm run verify
```

It syncs workspace metadata, checks architectural boundaries, typechecks, runs fast tests, and builds all workspaces. DB-backed verification is separate:

```bash
pnpm run verify:db
```

Local DB-backed tests read `TEST_DATABASE_URL` from the generated sandbox env
when it is not already set in the shell. The sandbox value points at the
current worktree's Postgres admin database. A root `.env.test.local` value can
still be used as a shared fallback:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

## Development Workflow

When adding or changing behavior:

1. Start in the owning bounded context.
2. Put commands, domain rules, events, read-model projection logic, UI, and tests near the feature they serve.
3. Promote code to `contracts/` only when multiple contexts need the same stable shape.
4. Promote code to `infrastructure/` only when it is runtime or provider implementation.
5. Keep deployables focused on wiring contexts, routes, services, and environment configuration.
6. Update the local context README or glossary when language or ownership changes.

For UI work, start with:

- [packages/design-system/README.md](packages/design-system/README.md)
- [packages/design-system/MARKETPLACE_SYSTEM.md](packages/design-system/MARKETPLACE_SYSTEM.md)
- `packages/design-system/src/`

## Event-Sourced Shape

Most business behavior follows this local pattern:

- Domain modules validate commands and emit named events.
- Event streams preserve aggregate history.
- Projections build task-specific read models.
- APIs expose the context-owned application surface.
- UI consumes context-owned contracts and read models.

Favor explicit events, deterministic projection behavior, and small context-owned support modules over broad shared abstractions.

## Documentation

Key references:

- [docs/README.md](docs/README.md): documentation map and ownership rules.
- [docs/PRODUCT.md](docs/PRODUCT.md): product vision, users, and marketplace economics.
- [docs/GLOSSARY.md](docs/GLOSSARY.md): canonical marketplace language and account-role naming rules.
- [docs/architecture/bounded-context-structure.md](docs/architecture/bounded-context-structure.md): bounded-context directory, export, and composition rules.
- [bounded-contexts/marketplace/docs/seller-fee-confirmation.md](bounded-contexts/marketplace/docs/seller-fee-confirmation.md): seller fee snapshot rules.
- [bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md](bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md): buyer-side marketplace checkout fee policy.
- [docs/runbooks/money-operations.md](docs/runbooks/money-operations.md): money operations guidance, launch checks, and Stripe smoke tests.
- [docs/runbooks/observability.md](docs/runbooks/observability.md): local observability stack.
- [docs/runbooks/postage-operations.md](docs/runbooks/postage-operations.md): postage provider configuration and label smoke checks.
- [docs/runbooks/realtime-sse.md](docs/runbooks/realtime-sse.md): realtime SSE behavior.
- [docs/runbooks/remote-dev.md](docs/runbooks/remote-dev.md): remote development workflow.
- [docs/runbooks/digitalocean-platform-deployment.md](docs/runbooks/digitalocean-platform-deployment.md): staging full-system platform and production deployment workflow.
- [docs/api/marketplace-api.md](docs/api/marketplace-api.md): marketplace API documentation.
- [docs/adr/0001-platform-api-observability.md](docs/adr/0001-platform-api-observability.md): platform API observability ADR.

## Observability

Local observability is Docker-backed and writes development logs under `artifacts/observability/`.

```bash
pnpm run dev:observability
pnpm run dev:observability:open
pnpm run dev:observability:down
```

See [docs/runbooks/observability.md](docs/runbooks/observability.md) for the full workflow.

## Structure Guardrails

The repo includes automated checks for architecture boundaries and localization. Run these directly when working near those concerns:

```bash
pnpm run check:structure
pnpm run check:localization
```

CI enforces structure with stricter single-slice support rules. If a change wants new shared code, make the ownership explicit before moving it out of the slice.
