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
docs/                  Product, language, runbooks, ADRs, and API documentation.
infrastructure/        Runtime adapters, persistence, observability, provider integrations, and test providers.
packages/design-system Canonical React UI system, tokens, primitives, shells, patterns, and showcase contracts.
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
- `reputation`: post-transaction reviews, ratings, feedback, and account review summaries.
- `settlement`: ledger truth, balances, wallets, payouts, fees, and rebates.
- `tax`: provider-agnostic tax quotes and order tax snapshots.

## Deployables

- `deployables/marketplace`: buyer and seller marketplace web app.
- `deployables/admin-web`: internal admin web app.
- `deployables/platform-api`: Hono-based platform API and HTTP composition root.
- `deployables/platform-worker`: background worker composition root.
- `deployables/design-system-showcase`: visual and contract surface for the design system.

Default local ports:

| Surface | URL |
| --- | --- |
| Dev portal | <http://localhost:6170> |
| Design system showcase | <http://localhost:6171> |
| Admin web | <http://localhost:6172> |
| Marketplace web | <http://localhost:6173> |
| Platform API | <http://localhost:6182> |
| Platform worker | <http://localhost:6183> |

## Prerequisites

- Node.js 22.
- npm.
- Docker with Docker Compose.
- Optional: Stripe CLI for webhook-driven payment smoke tests.

CI runs on Node 22 and uses `npm ci`, so local development should do the same when starting from a fresh checkout.

## Getting Started

```bash
npm ci
npm run dev:bootstrap
npm run dev
```

`npm run dev` starts shared Postgres, provisions the local database, bootstraps platform services, and runs the full local system.

Focused dev targets are available when you only need part of the system:

```bash
npm run dev:admin-web
npm run dev:marketplace-full
npm run dev:showcase
```

Useful local lifecycle commands:

```bash
npm run dev:down       # stop shared local services
npm run dev:db:refresh # destroy local Postgres data and bootstrap again
```

The default local database is `postgresql://postgres:postgres@localhost:5432/chase_sets`. Platform environment defaults live in:

- [deployables/platform-api/.env.example](deployables/platform-api/.env.example)
- [deployables/platform-worker/.env.example](deployables/platform-worker/.env.example)

Stripe and EasyPost are optional for local startup. When Stripe configuration is missing, platform payment flows use the fake payment processor.

## Common Commands

```bash
npm run typecheck
npm run test
npm run test:db
npm run build
npm run verify
```

The main verification path is:

```bash
npm run verify
```

It syncs workspace metadata, checks architectural boundaries and rollout rules, typechecks, runs fast tests, and builds all workspaces. DB-backed verification is separate:

```bash
npm run verify:db
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

- [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)
- [docs/DESIGN-SYSTEM-COMPONENTS.md](docs/DESIGN-SYSTEM-COMPONENTS.md)
- `packages/design-system/src/`
- `deployables/design-system-showcase/`

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

- [docs/PRODUCT.md](docs/PRODUCT.md): product vision, users, and marketplace economics.
- [docs/GLOSSARY.md](docs/GLOSSARY.md): canonical marketplace language.
- [docs/LANGUAGE-STANDARD.md](docs/LANGUAGE-STANDARD.md): naming guidance across code, docs, and UI copy.
- [docs/PERMANENT-LISTING-FEES.md](docs/PERMANENT-LISTING-FEES.md): listing fee snapshot rules.
- [docs/MONEY-OPERATIONS-RUNBOOK.md](docs/MONEY-OPERATIONS-RUNBOOK.md): money operations guidance.
- [docs/OBSERVABILITY-RUNBOOK.md](docs/OBSERVABILITY-RUNBOOK.md): local observability stack.
- [docs/REALTIME-SSE-RUNBOOK.md](docs/REALTIME-SSE-RUNBOOK.md): realtime SSE behavior.
- [docs/REMOTE-DEV.md](docs/REMOTE-DEV.md): remote development workflow.
- [docs/api/marketplace-api.md](docs/api/marketplace-api.md): marketplace API documentation.
- [docs/adr/0001-platform-api-observability.md](docs/adr/0001-platform-api-observability.md): platform API observability ADR.

## Observability

Local observability is Docker-backed and writes development logs under `artifacts/observability/`.

```bash
npm run dev:observability
npm run dev:observability:open
npm run dev:observability:down
```

See [docs/OBSERVABILITY-RUNBOOK.md](docs/OBSERVABILITY-RUNBOOK.md) for the full workflow.

## Structure Guardrails

The repo includes automated checks for boundaries, language, localization, money rollout safety, design-system migration, and permanent listing fee behavior. Run these directly when working near those concerns:

```bash
npm run check:structure
npm run check:localization
npm run check:ui-migration
npm run check:money-rollout
npm run check:permanent-listing-fees
```

CI enforces structure with stricter single-slice support rules. If a change wants new shared code, make the ownership explicit before moving it out of the slice.
