# Product Asset Normalization

## Intent

Normalize provider-fed product images into Chase Sets-owned WebP assets that are right-sized for search results, catalog item/detail pages, and card thumbnails. The import pipeline should generate all required variants from a single high-resolution source image when possible, beginning with TCGdex imports as the first verification path.

Primary goals:

- Reduce storage and transfer waste by avoiding oversized images in browse surfaces.
- Keep canonical product imagery under Catalog ownership, not provider hotlinks.
- Let Discovery select optimal image variants for search and detail presentation without owning source image truth.
- Preserve high-resolution source fidelity for future variants while serving WebP everywhere.
- Treat DPI/PPI as an output-use concern: CSS/display pixel targets and device-pixel-ratio variants should determine generated pixel dimensions; embedded image DPI metadata should not drive browser delivery.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-product-asset-normalization`
- Branch: `codex/product-asset-normalization`
- Base: source repo `main` at `8cc4f1e6cff8c07820fe00bd88651e74d74fa83d`
- Source repo caveat: `main` is behind `origin/main` by 43 commits and has an unrelated untracked plan file at `.codex/plans/20260516-environment-domain-names.md`; this planning worktree was created from the current local `main` per workflow.
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox id: `648ec382`
- Sandbox doctor: passed. Port base `9300`; marketplace web `http://localhost:9303`; platform API `http://localhost:9312`; database port `9320`.

## Owning Contexts

Catalog is the behavior owner for canonical product asset truth because it owns Catalog Items, Source Observations, provider keys, external product references, and current `image_urls`.

Discovery is the read-model and presentation owner for search, browse, and item detail usage. Discovery should project Catalog-published asset facts into search and item-detail read models and choose the best variant for each surface.

Infrastructure may own reusable technical adapters only, such as object storage and image processing primitives, when they are provider-agnostic and reusable. Catalog should own the import decision, variant policy, asset metadata, object keys, and published facts.

Deployables remain thin composition roots for wiring storage/image services and serving local filesystem-backed assets during development.

Design System should own reusable image display components and contracts only where UI patterns need a canonical `srcSet`/thumbnail behavior. It should not own product asset lifecycle or provider import logic.

## Repo Evidence

- `bounded-contexts/catalog/README.md` says Catalog owns canonical item identity and field/category facts, while search and discovery filtering belong elsewhere.
- `bounded-contexts/discovery/README.md` says Discovery owns browse, search, detail presentation, search indexes, and projection workflows, and does not own canonical catalog item truth.
- Current local `main` stores `image_urls` as a string array on Catalog Item events/read models and Discovery projects those raw URLs into search and item-detail pages.
- Current local `main` does not include TCGdex source observations, but sibling worktree `D:\Users\ToddS\Source\Repos\chase-sets-20260516-tcgdex-asset-storage` on `codex/tcgdex-asset-storage` adds Source Observations and Catalog-owned asset storage.
- The TCGdex asset branch currently downloads only TCGdex `high.webp`, stores it under deterministic object keys, and promotes Chase Sets-owned image URLs into Catalog Items.
- `docs/runbooks/catalog-asset-storage.md` in the TCGdex asset branch documents filesystem local storage, S3-compatible shared storage, production rejection of filesystem storage, and deterministic TCGdex keys under `catalog/source-observations/tcgdex/{languageCode}/{externalKey}/high.webp`.
- No image-processing dependency such as `sharp` is present in the current local lockfile; the TCGdex asset branch adds S3 storage dependencies but not a WebP resize/encode pipeline.
- Discovery search currently passes `item.image_urls[0]` into the design-system `ListingCard`.
- `ListingCard` renders product media in an approximately 9-10rem column on desktop and a full-width compact mobile frame, so a `search-card` variant around 160 CSS px plus 2x density covers the intended card-art width without shipping detail/source assets.
- Discovery item detail uses `ImageGallery` with `aspectRatio="5/7"` and max widths around 22-24rem, so a detail variant around 384-480 CSS px plus 2x density is enough for current layouts.
- `ImageGallery` thumbnails render at `h-16 w-16`, and cart line item images render around 4.75-5.5rem, so compact thumbnail variants should cover 64-96 CSS px with 2x density.

## Resolved Decisions

- Canonical term: `Product Asset Set`.
- `Product Asset Set` means the Catalog-owned normalized set of WebP variants derived from one source image for a Catalog Item or Source Observation.
- `Asset Variant` means one generated WebP file with a declared usage, pixel dimensions, quality policy, object key, byte size when known, and public URL.
- `Source Asset` means the highest-quality imported image retained for future variant generation and provenance. For TCGdex this starts from `high.webp`.
- Catalog should keep provider URL data as provenance and store Chase Sets-owned URLs in promoted Catalog facts.
- TCGdex is the first test path; manual/admin image URL entry can stay compatible during migration but should eventually normalize through the same Product Asset Set pipeline.
- DPI/PPI policy: store and serve by pixel dimensions and DPR-ready variants, not by trusting embedded DPI metadata. The plan treats “1x/2x” as display-density targets and keeps optional source metadata only for diagnostics.
- Catalog will publish structured Product Asset Sets as the canonical contract and keep `image_urls` as a migration compatibility projection.
- Asset sizing policy: generate fixed role-based WebP variants from the source asset during import rather than serving only high-resolution images or deferring to CDN transforms.

## Open Questions

### 1. Published Catalog Contract Shape - Answered

Decision needed: should Catalog publish structured Product Asset Sets as the canonical event/read-model shape, while retaining `image_urls` only as a compatibility projection during migration?

Why it matters: Discovery needs to choose `search-card`, `catalog-detail`, and `thumbnail` variants without parsing URL naming conventions. A structured contract also prevents provider import, Catalog promotion, and UI surfaces from each inventing their own asset sizing rules.

Recommended answer: yes. Add a structured `product_assets`/`asset_set` shape to Catalog Item state, read models, and Catalog-published events; keep `image_urls` populated from the primary/detail variant until downstream callers are migrated.

Repo evidence: Catalog Item currently emits `catalog.catalog-item.image-urls-set` with only `imageUrls: string[]`, while Discovery search and item-detail project that array unchanged. The TCGdex asset branch already centralizes provider mirroring in Catalog Source Observations, which is the right place to extend from one stored file to many generated variants.

Consequence of choosing differently: if Catalog keeps only raw URLs, Discovery must infer variants from string patterns or request server-side resizing later. That saves migration work now but preserves entropy and weakens the event contract.

Answer: yes. Catalog will publish structured Product Asset Sets as canonical asset facts and keep legacy `image_urls` only for compatibility until Discovery and other consumers are migrated.

### 2. Asset Variant Sizing Policy - Answered

Decision needed: should the plan define fixed role-based 1x/2x WebP variants now, based on current UI frames, instead of storing only one high-res WebP and relying on browser resizing?

Why it matters: the storage and import pipeline need a concrete variant contract before TCGdex import can become a meaningful first test. Search, card thumbnails, and detail pages have different pixel needs, and the browser cannot reduce transfer bytes if only the high-resolution source URL is available.

Recommended answer: yes. Generate fixed role variants for `thumbnail`, `search-card`, and `catalog-detail`, each with 1x and 2x density targets, plus a retained `source` file for provenance/regeneration.

Repo evidence: Search `ListingCard` frames are roughly 144-160 CSS px wide; `ImageGallery` detail frames top out around 22-24rem wide; gallery thumbnails are 64 CSS px; cart line item images are around 76-88 CSS px.

Consequence of choosing differently: high-res-only storage reduces implementation work but wastes bandwidth on browse pages. CDN transforms reduce stored variants but couple Catalog/Discovery correctness to URL conventions and cache behavior outside the event contract.

Answer: fixed variants. The implementation should generate role-based WebP variants on import and publish those structured variants in Catalog asset facts.

## Implementation Checklist

- Add Catalog glossary/doc entries for `Product Asset Set`, `Asset Variant`, and `Source Asset`.
- Extend the TCGdex asset-storage plan/branch or rebase this plan onto it before implementation, because local `main` lacks Source Observations.
- Add a Catalog-local asset normalization service in the Source Observations slice or a narrowly named Catalog support directory if reused by Catalog Items and Source Observations.
- Add a reusable infrastructure image processor only if the implementation needs a provider-agnostic adapter boundary; prefer `sharp` unless repo constraints favor another maintained Node image library.
- Generate WebP variants from the single high-resolution source image:
  - `thumbnail`: 96 CSS px target, 1x and 2x variants, object-fit contain, transparent/neutral padding only if required by processor behavior.
  - `search-card`: 160 CSS px target, 1x and 2x variants for search/catalog grids.
  - `catalog-detail`: 480 CSS px target, 1x and 2x variants for item detail and admin review.
  - `source`: original high-resolution WebP retained for review/regeneration, not used by default browse surfaces.
- Store each variant with deterministic keys that include provider, language, external key, asset role, width, DPR, and content hash or source hash.
- Persist variant metadata with width, height, DPR, role, media type `image/webp`, byte size when known, generated-at time, source hash, and public URL.
- Make Source Observation normalized payload carry structured assets and compatibility `imageUrls`.
- Make promotion attach the Product Asset Set to the draft Catalog Item and keep `SetCatalogItemImageUrls` compatibility behavior until Discovery migrates.
- Update Catalog projections and admin UI contracts to show source/detail/thumbnail variant availability without custom design-system overrides.
- Update Discovery search and item-detail projections to store structured asset variants and select the smallest acceptable WebP for each usage.
- Update Discovery UI to render `srcSet`/`sizes` from projected variants, with existing default product image fallback.
- Add migration/backfill path for existing Catalog Items with only `image_urls`: represent them as legacy external assets initially, then optionally normalize through an admin repair job.
- Add storage lifecycle guidance for replacing obsolete variants when regenerated from the same source.

## Target Variant Policy

Browsers choose images by pixel density and layout width; embedded DPI/PPI metadata is not a reliable web delivery signal. The implementation should express density as DPR variants:

| Role | CSS target | Generated widths | Default use |
| --- | ---: | ---: | --- |
| `thumbnail` | 96 px | 96w, 192w | compact card thumbnails, admin rows, cart line item art |
| `search-card` | 160 px | 160w, 320w | search results and catalog item cards |
| `catalog-detail` | 480 px | 480w, 960w | item detail, admin review preview |
| `source` | natural | original | provenance, review, future regeneration |

Card art should preserve aspect ratio and avoid destructive cropping. UI surfaces can constrain frames through object-fit contain.

## Stress Tests

- Normal flow: TCGdex set import downloads one high-resolution WebP, generates all variants, stores them, records a Source Observation, promotes to a draft Catalog Item, and Discovery displays search/detail variants.
- Missing image: TCGdex card without image records no Product Asset Set and falls back to default imagery; the observation remains reviewable.
- Failed derivative generation: if a provider declares an image and derivative generation fails, the observation should fail and be retryable; do not record partial canonical assets silently.
- Replay/idempotency: re-import of the same source hash should compute the same deterministic keys and avoid duplicate events.
- Provider update: changed source hash after terminal promotion should require a changed-observation review rather than mutating published Catalog Item imagery silently.
- Downstream stale data: Discovery should continue serving the previous projected asset set until the Catalog asset event replays successfully.
- Low-value card economics: search and thumbnail surfaces must not fetch detail/source images by default, keeping cheap-card browsing light and margin-friendly.
- Multi-context handoff: Catalog publishes Product Asset Set facts; Discovery reshapes only for browse performance; Marketplace/Checkout/Ordering consume projected display URLs but do not own the asset contract.

## Documentation To Promote

- `bounded-contexts/catalog/GLOSSARY.md`: add Product Asset Set, Asset Variant, Source Asset.
- `bounded-contexts/catalog/docs/source-observation-integration.md`: extend TCGdex import policy from mirroring `high.webp` to generating normalized variants.
- `docs/runbooks/catalog-asset-storage.md`: update storage keys, variant policy, local/S3 config, regeneration, and failure handling once the asset-storage branch is in the implementation base.
- `docs/README.md`: ensure the catalog asset storage runbook remains listed after promotion.
- Consider an ADR only if the implementation commits to a hard-to-reverse image processing dependency or CDN/public URL convention.

## Goal Completion Criteria

The implementation goal should:

- Use worktree `D:\Users\ToddS\Source\Repos\chase-sets-20260516-product-asset-normalization` or an updated worktree rebased onto the TCGdex asset-storage branch.
- Own implementation in Catalog, Discovery projections/UI, storage/image-processing adapters, and durable docs.
- Promote docs listed above alongside code.
- Verify TCGdex import creates source plus WebP variants from one high-resolution source.
- Verify Search, Catalog Item/admin, Discovery item detail, and card thumbnail surfaces select right-sized WebP variants.
- Run relevant Catalog, Discovery, storage, typecheck, structure, and localization checks.
- Run mobile and desktop visual checks for search results, item detail, and admin Source Observation/Catalog Item pages.
- Submit a PR, get CI passing, merge, verify staging deploy behavior with asset storage configured, and retain this plan file for reviewer traceability.

## Implementation Progress

Completed in this worktree:

- Fast-forwarded onto the TCGdex asset-storage baseline so Source Observations and Catalog asset storage are the implementation base.
- Added Catalog Product Asset Set types and a Catalog Source Observation normalization service that generates `source`, `thumbnail`, `search-card`, and `catalog-detail` WebP assets from one high-resolution source.
- Added `sharp` to Catalog image processing and allowed its pnpm build script in the workspace build policy.
- Updated TCGdex import to download only the provider high-resolution WebP, generate the normalized Product Asset Set, publish compatibility `imageUrls` from `catalog-detail`, and keep provider source hashes independent of Chase Sets asset hosts.
- Added Catalog Item `productAssetSets` command/event/state/projections and promotion wiring from Source Observations.
- Projected Product Asset Sets through Discovery search and item-detail read models.
- Updated Discovery search cards and item detail gallery to select right-sized WebP variants with `srcSet`/`sizes`; cart/open-graph fall back through Product Asset Sets before legacy image URLs.
- Extended design-system `ListingCard` and `ImageGallery` image contracts to support responsive `srcSet` and thumbnail sources without custom UI overrides.
- Updated Catalog glossary, Source Observation integration docs, and the Catalog asset storage runbook.

Verification run:

- `pnpm --filter @chase-sets/catalog test`
- `pnpm --filter @chase-sets/discovery test`
- `pnpm --filter @chase-sets/design-system test`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `git diff --check`
- `pnpm run verify:build`

Deferred to follow-up/PR validation:

- Full `pnpm run verify` and CI.
- Browser visual checks for search, item detail, and admin screens with seeded imported assets. Attempted local visual setup on May 16, 2026; the default sandbox web ports were occupied by another worktree, and the API bootstrap failed during existing marketplace seed reconciliation with `Offer not found` before platform-api started. The search page did load cleanly without catalog data, but that does not cover image-bearing Product Asset Set rendering.
- Staging deployment verification with shared asset storage configured.
