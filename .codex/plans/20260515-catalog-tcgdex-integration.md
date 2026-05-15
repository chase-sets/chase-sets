# Catalog TCGdex Integration System

## Intent

Build a Catalog-owned integration system that can ingest provider observations, promote trusted observations into canonical Catalog Items, and use TCGdex as the first provider for Pokemon card-print data and images.

The system should preserve Chase Sets Catalog as the canonical product model while keeping provider-specific payloads, identifiers, source provenance, and refresh behavior isolated behind an integration boundary.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-catalog-tcgdex-integration`
- Branch: `codex/catalog-tcgdex-integration`
- Base: current local `main` HEAD `8cc4f1e6 Add notifications database to staging platform (#72)`; source `main` was behind `origin/main` by 32 commits when the worktree was created.
- Sandbox id: `b8b2d9fc`
- Port base: `9000`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- Setup caveats: pnpm reported existing cyclic workspace dependencies among checkout, ordering, marketplace-seed-testing, and discovery; no setup failure.

## Owning Contexts

- Catalog owns the integration system because it owns canonical product identity, dynamic Fields, Dimensions, Blueprints, Product resolution, image URL facts, and external product references.
- Discovery remains downstream and should project Catalog-published facts into search, facets, and detail pages. It must not ingest TCGdex directly.
- Pricing remains downstream and may later consume price signals, but TCGdex pricing fields should not be promoted into Catalog in the first implementation.
- Inventory remains downstream for seller-held copy facts. TCGdex card data must not create seller inventory.

## Resolved Decisions

- Add provider ingestion inside the Catalog bounded context rather than a deployable or shared infrastructure package.
- Use a source-observation layer before canonical promotion so provider payloads do not become Catalog truth automatically.
- Use TCGdex as the first provider with provider key `tcgdex`.
- Ingest TCGdex card/set metadata and image asset bases first; do not ingest TCGdex market pricing into Catalog.
- Represent one TCGdex card print in one language as a Catalog Item, because the existing graded-card model says card name, set, card number, rarity, language, artist, and release year are Catalog Item identity facts.
- Keep sellable variation as Product Dimensions. For Pokemon cards this means finish/printing, raw-vs-graded form, condition, grading company, and grade belong to product resolution rather than duplicated Catalog Items.
- Use existing Catalog external product references for promoted source mapping, but extend the integration plan with richer source provenance because current references only store provider key, external key, and selected options.
- Treat TCGdex card images as source-backed asset URLs and store both low/high webp-ready URL forms or a canonical asset base plus derived format/quality rules.
- Preserve raw provider payloads only if legally acceptable; otherwise store normalized observations, hashes, timestamps, and source URLs/IDs.
- Require admin review before TCGdex observations create or update Catalog Items. TCGdex imports write source observations first, and promotion emits Catalog commands only after approval.
- First implementation imports one configured TCGdex set in one language. This keeps the slice small enough to verify idempotency, source conflicts, review flow, and Catalog command promotion before scaling to all English or multi-language sync.
- Include a Catalog-owned admin UI in the first implementation for source-observation review, conflict inspection, image preview, promotion, and rejection.
- Fetch the first one-set import from live TCGdex REST at operator request time. Tests should use fixtures and source-record hashes for deterministic verification.

## Repo Evidence

- `bounded-contexts/README.md` states Catalog is upstream for canonical item references and Discovery depends on Catalog for item/category/blueprint/field facts.
- `bounded-contexts/catalog/README.md` states Catalog owns `catalog_item_id`, product schema snapshots, Field values, category membership, and resolved Product validity.
- `bounded-contexts/catalog/docs/graded-card-data-model.md` states card name, set, card number, rarity, language, artist, and release year belong to the Catalog Item, while seller-copy slab/population facts belong to Inventory.
- `bounded-contexts/catalog/features/catalog-items/domain/domain.ts` already supports `languageCode`, localized title/subtitle/description, `fieldValues`, `imageUrls`, tags, and external product references.
- `bounded-contexts/catalog/features/catalog-items/read-model/schema.ts` already persists `catalog_items`, `catalog_external_product_references`, `image_urls`, and admin list/detail projections.
- `bounded-contexts/discovery/README.md` states Discovery owns search/detail projections, not canonical Catalog truth.
- `bounded-contexts/pricing/README.md` states Pricing owns price signals and estimates, not product truth.

## TCGdex Evidence

- TCGdex REST is HTTPS GET-only and returns JSON.
- TCGdex card list endpoint is `https://api.tcgdex.net/v2/{language}/cards`; single card endpoint is `https://api.tcgdex.net/v2/{language}/cards/{id}`.
- TCGdex set endpoint is `https://api.tcgdex.net/v2/{language}/sets/{id}`.
- Card objects include `id`, `localId`, `name`, optional `image`, `category`, optional `illustrator`, optional `rarity`, `set`, `variants`, optional `boosters`, optional `pricing`, and `updated`.
- Set objects include `id`, `name`, optional logo/symbol asset bases, card counts, serie, release date, legal flags, optional boosters, and cards.
- Asset bases can be expanded for cards as `{assetBase}/{quality}.{extension}` where quality is `high` or `low`, and extension is `png`, `webp`, or `jpg`.
- TCGdex recommends `webp` for web display; card image high quality is `600x825`, low quality is `245x337`.
- The TCGdex cards database README says the database is MIT licensed and not affiliated with Nintendo or The Pokemon Company.

## Open Questions

- None for the first implementation slice.

## Implementation Checklist

- Completed: Added a Catalog `source-observations` slice with manifest, route, schema, runtime, query, projection, API, client, and UI wiring.
- Completed: Defined source-observation state, events, DTOs, provenance fields, statuses, and `catalog_source_observations` read model.
- Completed: Added a live TCGdex REST client for one-set imports, card detail expansion, source hash generation, and low/high webp asset URL derivation.
- Completed: Stripped TCGdex pricing fields from stored source payloads and source-record hashes.
- Completed: Added TCGdex import workflow for a single requested language and set.
- Completed: Added review-first promotion from source observation into draft Catalog Items using existing Pokemon card blueprint, fields, category, tags, image URLs, and external product references.
- Completed: Scoped promoted TCGdex external references by language, for example `en:base1-4`, so later multilingual imports do not collide.
- Completed: Added admin review pages for listing, filtering, viewing, promoting, and rejecting source observations.
- Completed: Added provider-mapping and source-observation domain tests covering normalized payloads, image derivation, deterministic observation IDs, source hashes, idempotent same-hash refresh, changed observed refresh, promotion status, and terminal refresh/rejection guardrails.
- Deferred: Rich operator-facing conflict workflows for duplicate canonical identity and missing image warnings should be the next slice after this first provider path is in use.
- Not required: Downstream integration-event tests were not added because this slice creates draft Catalog Items and does not change Catalog published snapshot contracts.

## Verification Notes

- `pnpm --filter @chase-sets/catalog run test` passed.
- `pnpm run check:structure` passed.
- `pnpm run check:localization` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:build` passed.
- `git diff --check` passed.
- Browser verified `http://localhost:9002/catalog/source-observations` after authenticated sign-in.
- Desktop screenshot saved at `.codex/artifacts/catalog-tcgdex/source-observations-desktop-1280x720.png`.
- Mobile screenshot saved at `.codex/artifacts/catalog-tcgdex/source-observations-mobile-390x844.png`.
- Live TCGdex import verified against `en/base1`: 102 observations imported and rendered in the review table.
- Detail page verified for `tcgdex_en_base1_4`, including source provenance and card image.
- Review actions verified: promotion created a draft Catalog Item with TCGdex image URLs and language-scoped external reference; rejection marked an observation rejected with a reason.

## Documentation To Promote

- Add a Catalog-owned doc for provider observation and promotion policy under `bounded-contexts/catalog/docs/`.
- Update `bounded-contexts/catalog/README.md` if source-observation integration becomes a first-class Catalog capability.
- Update `bounded-contexts/catalog/GLOSSARY.md` with new local terms such as Source Observation, Provider Mapping, and Promotion if they appear in APIs/events/UI.
- Add an ADR only if we decide to auto-promote provider observations without admin review, because that would make external-source trust a hard-to-reverse operational policy.

## Goal Completion Criteria

- Implementation remains inside the dedicated worktree and branch.
- Product code changes are owned by Catalog unless a downstream projection contract change is explicitly required.
- Durable docs are promoted in the owning context.
- Automated checks include focused unit tests plus relevant structure/typecheck/test commands.
- If UI/admin review surfaces are added, verify desktop and mobile behavior with browser screenshots.
- Submit a PR, get CI passing, merge, verify staging deploy, and retain this plan with the implementation.
