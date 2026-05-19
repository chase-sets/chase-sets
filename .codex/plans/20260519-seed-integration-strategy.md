# Seed And Integration Strategy

## Intent

Reset seeding and test data so Catalog starts from provider-backed facts instead of hand-authored fake Pokemon cards, while keeping dev, preview, and test representative enough to exercise account, inventory, marketplace, checkout, ordering, fulfillment, payment, settlement, reputation, support, and pricing workflows.

Staging and production should be long-lived environments with only critical bootstrap data and real operator/imported data. Fake accounts, purchases, listings, reviews, support cases, and synthetic marketplace activity should not be created there.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-seed-integration-strategy`
- Branch: `codex/seed-integration-strategy`
- Sandbox id: `5c3b3ec6`
- Dependency setup: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed via `pnpm run sandbox:doctor`
- Setup blockers: none

## Owning Contexts

- Catalog owns provider-fed product facts, Source Observations, provider keys/external keys, normalized candidate facts, Product Asset Sets, promotion into Catalog Item commands, Fields, Dimensions, Options, Components, Blueprints, Categories, Reference Types, and Reference Records.
- Identity owns real account/user/bootstrap identity. Production bootstrap already has `bootstrapPlatformAdminIdentity` and `bootstrapPlatformAdminPassword`.
- Commercial Terms owns seller-side marketplace fee policy. Its default fee schedules are likely critical operating data, but synthetic agreements or scenario overrides should be classified separately.
- Inventory, Marketplace, Checkout, Ordering, Fulfillment, Payments, Settlement, Reputation, Support, Experience, and Pricing own scenario/demo data for non-production only.
- Deployables should remain thin composition roots; environment-specific bootstrap policy should not turn deployables into owners of business data.

## Repo Evidence

- `bounded-contexts/catalog/README.md` names Catalog as the owner of Dimensions, Options, Products, Blueprints, Fields, Components, Categories, Reference Types, Reference Records, Source Observations, and provider-fed catalog data.
- `bounded-contexts/catalog/docs/source-observation-integration.md` says external providers write Source Observations first; operators promote or reject them after review. Promotion creates draft Catalog Items and keeps downstream product truth out of provider payloads until promotion.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` currently promotes TCGdex observations by assigning `catalogSeedIds.blueprints.pokemonCardSingle`, setting `catalogSeedIds.fields.*`, assigning `catalogSeedIds.categories.singles`, and ensuring only the Pokemon reference hierarchy dynamically.
- `bounded-contexts/catalog/support/authoring-support/seed.ts` currently seeds Dimensions, Fields, Reference Data, Components, Blueprints, Categories, and Catalog Items as one Pokemon TCG seed.
- `bounded-contexts/catalog/features/catalog-items/api/seed.ts` creates published fake/sample Catalog Items, fallback fake CDN images, and sample external product references.
- `deployables/platform-api/src/bootstrap.ts` calls `seedApiHostIfEmpty(...)` for platform bootstrap. That runs every module `seed` for all mounted contexts, then reconciles platform admin if configured.
- `infrastructure/bounded-context-runtime/index.ts` shows `seedApiModuleIfEmpty` runs `module.seed(...)` even when events already exist, under "seed reconciliation."
- `deployables/platform-api/src/config.ts` treats only `DEPLOYMENT_ENVIRONMENT=production` or `NODE_ENV=production` as production-like, but does not model staging/preview/dev seed policy explicitly.
- `deployables/marketplace-seed-testing/index.ts` composes a multi-context seed runtime for database-backed tests; it can remain test/support-only if the seed sources are reset.
- Downstream contexts such as Inventory, Marketplace, Ordering, and Reputation have `seedRequirements` that depend on Catalog and Identity, and their runtime seeds import `catalogSeedIds`/`identitySeedIds` directly.

## Contradictions Found

- Desired empty staging/prod conflicts with current platform-api bootstrap because it always invokes all context seeds, and those seeds include fake/demo data.
- Desired provider-backed Catalog setup is only partially true today: TCGdex import creates Source Observations and some Reference Records, but promotion requires pre-seeded Pokemon Fields, Categories, Dimensions, Components, and Blueprints.
- Current Catalog seed mixes critical authoring structure with fake/sample Catalog Items. That prevents staging/prod from getting the real structure without also receiving demo items.
- Current downstream demo seeds reference hard-coded `catalogSeedIds.items.*`, so replacing Catalog seed with provider-imported item IDs requires a scenario fixture layer that resolves items by stable provider references or curated scenario aliases.

## Resolved Decisions

- Split data setup into three explicit profiles:
  - `critical-bootstrap`: schema, required operating policies, platform admin identity/auth when configured, provider/integration definitions, and reusable Catalog authoring structure needed for real import and publication.
  - `catalog-integration-bootstrap`: provider-owned or provider-derived Catalog structure and reference facts, imported through Catalog behavior with idempotent reconciliation. For TCGdex, this means Pokemon card fields, reference types, reference records, categories, dimensions, components, and blueprints become a Catalog integration profile instead of sample seed data.
  - `scenario-seed`: fake/demo accounts, inventory, listings, offers, checkout sessions, purchases, shipments, reviews, support cases, pricing examples, and low-value card marketplace cases. This profile is allowed only in dev, preview, and tests.
- Keep provider item ingestion review-first. TCGdex should import Source Observations; promotion should remain a Catalog action. Non-prod scenario setup may auto-promote and publish a curated provider-backed subset, but staging/prod should not silently publish provider observations during app bootstrap.
- Staging TCGdex imports are operator-triggered only. Bootstrap should create the real capability and critical structure, but should not auto-import provider content in staging.
- Treat commerce product-resolution dimensions such as Form, Condition, Grading Company, and Grade as Chase Sets/Pokemon TCG marketplace modeling, not raw TCGdex facts. The TCGdex profile can install them because it is the Pokemon TCG integration profile, but future TCG integrations should declare their own profile instead of inheriting Pokemon-specific fields by accident.
- Replace hard-coded seed item IDs in downstream scenario seeds with scenario catalog aliases resolved from provider references after import/promotion, for example `pokemon.base-set.charizard.raw-near-mint` mapping to a promoted Catalog Item and selected options.
- Staging and production should bootstrap critical data only. Operator-run imports can populate Source Observations and then reviewed Catalog Items. Long-lived environments should never be reset/reseeded with scenario data.
- Implementation started by extending bounded-context modules with `seedProfiles` and `BcSeedOptions`, then passing environment-selected profiles through platform API bootstrap.
- Catalog now participates in `catalog-integration-bootstrap` and `scenario-seed`; its TCGdex/Pokemon integration structure can reconcile without creating sample Catalog Items.
- Commercial Terms now participates in `critical-bootstrap` and `scenario-seed`; default schedules are critical data, while the demo seller agreement is scenario data.
- TCGdex promotion now resolves active Blueprint, Field, and Category IDs by Catalog keys from the integration profile instead of directly assigning seed constants at the promotion call site.
- Downstream runtime scenario seeds now consume `catalogScenarioItems` from Catalog seed-support instead of directly importing `catalogSeedIds.items`.

## Open Questions

- None.

## Recommended Answer

Use operator-triggered imports for staging and production. This is now the resolved answer. It keeps long-lived environments honest: bootstrap creates the capability to import, review, promote, and publish real data, but does not mutate the catalog with provider content unless an operator asks for it. Preview/dev/test can auto-import, promote, and publish a curated set for realistic workflows.

## Implementation Checklist

- [x] Add an explicit seed/bootstrap profile model, likely in bounded-context runtime or platform runtime, with environment resolution for `dev`, `test`, `preview`, `staging`, and `production`.
- [x] Update platform-api bootstrap so staging/production run `critical-bootstrap` and `catalog-integration-bootstrap` only, and dev/preview/test can opt into `scenario-seed`.
- [x] Split Catalog seed into:
  - critical/provider profile reconciliation for Pokemon TCG structure,
  - TCGdex import/profile helpers,
  - sample item/scenario fixture setup for non-prod only.
- [x] Refactor TCGdex promotion to resolve Blueprint, Field, Category, Reference Type, and Reference Record IDs by Catalog keys/provider attributes instead of `catalogSeedIds`.
- [x] Introduce a provider/integration profile contract inside Catalog, not deployables. It should describe fields, dimensions/options, components, blueprints, categories, reference types, reference records, provider key, supported option kinds, import scopes, and item promotion mapping.
- [x] Move fake Catalog Items out of critical Catalog bootstrap and into a non-prod scenario package, preferably backed by TCGdex-curated imports rather than hand-authored fake catalog items.
- [x] Replace downstream `catalogSeedIds.items.*` dependencies with scenario alias resolution after provider-backed catalog setup.
- [x] Keep fake accounts, inventory, listings, orders, fulfillment, payments, settlement, reputation, support, and experience records inside `scenario-seed` only.
- [x] Add tests that assert staging/production seed profile does not create fake accounts, catalog items, listings, orders, reviews, or support cases.
- [x] Add tests that dev/preview/test scenario setup creates enough provider-backed catalog, inventory, listings, purchases, reviews, and low-value card cases without importing a huge dataset.
- [x] Document the environment data policy in a durable architecture/runbook note and link it from `docs/README.md`.

## Documentation To Promote

- System decision: `docs/adr/0003-environment-bootstrap-and-scenario-data.md`
- Architecture/runbook: `docs/architecture/environment-data-profiles.md`
- Catalog context note: `bounded-contexts/catalog/docs/provider-integration-profiles.md`
- Potential glossary clarification: `Catalog Integration Profile` owned by Catalog.

## Verification

- `pnpm --filter @chase-sets/app-platform-api test:fast` passed.
- `pnpm --filter @chase-sets/app-platform-api typecheck` passed.
- `pnpm --filter @chase-sets/app-platform-api test` passed with the DB-backed bootstrap integration suite skipped because `TEST_DATABASE_URL` was not set.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:test` passed.
- `pnpm --filter @chase-sets/catalog test -- source-observations` passed after the promotion key-resolution change.
- `pnpm --filter @chase-sets/app-platform-api typecheck` passed after adding Catalog scenario aliases.
- `pnpm --filter @chase-sets/app-platform-api test:fast` passed after adding Catalog scenario aliases and non-prod scenario bootstrap assertions.
- `pnpm run check:structure` passed after adding Catalog scenario aliases.
- `pnpm run check:localization` passed after adding Catalog scenario aliases.
- `pnpm run verify:typecheck` passed after adding Catalog scenario aliases.
- `pnpm run verify:test` passed after adding Catalog scenario aliases.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
