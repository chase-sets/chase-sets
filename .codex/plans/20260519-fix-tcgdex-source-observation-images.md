# TCGDex Catalog Asset Promotion

## Intent

TCGDex imports should keep provider-derived asset details only inside Catalog Source Observation provenance. Public asset URLs stored in the Chase Sets asset bucket should not reveal provider, language, or external card identifiers. Source Observations should display provider CDN imagery while under review, and promoted Catalog Items must receive Catalog Item-owned Chase Sets asset URLs under `catalog/items`. Stored assets must be publicly readable through the asset CDN, and long-running set imports need visible operator progress.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-fix-tcgdex-source-observation-images`
- Branch: `codex/fix-tcgdex-source-observation-images`
- Sandbox id: `09eadff2`; `pnpm run sandbox:doctor` passed.
- Dependency setup status: complete via `pnpm run deps:install`.
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known.

## Owning Contexts

- Catalog owns Source Observations and Product Asset Sets.
- Catalog Source Observations own TCGDex provider integration, temporary candidate imagery, review, and promotion orchestration.
- Catalog Items own promoted item imagery and published Product Asset Sets.
- `infrastructure/object-storage` owns the reusable S3-compatible write adapter used by Catalog asset storage ports. Adapter changes must stay generic; Catalog naming and promotion policy should remain in Catalog.
- DigitalOcean catalog asset infrastructure owns bucket/CDN provisioning and already declares the environment buckets as `public-read`.

## Resolved Decisions

- The failing sample URL is a Catalog-owned generated asset URL, not a TCGDex provider URL.
- Live HEAD and GET requests to `https://assets.staging.chasesets.com/catalog/source-observations/tcgdex/en/me03-039/catalog-detail-480w-1x-a1e63942a9c9.webp` returned `403 Forbidden`, which means URL generation succeeded but public object access failed.
- Keep Product Asset Set normalization intact for promoted Catalog Item assets; patch the S3-compatible object write so every stored public asset receives the same public-read intent as the bucket.
- Add the regression test in `infrastructure/object-storage` because the behavior is adapter-level and should protect any future Catalog asset writes.
- Catalog is the owning context because `bounded-contexts/catalog/README.md` says Catalog owns Provider Source Observations before review and promotion, and `bounded-contexts/catalog/GLOSSARY.md` defines Product Asset Set, Source Asset, and Asset Variant as Catalog concepts.
- `bounded-contexts/catalog/context.json` exposes the `catalogAssetStorage` host port for Catalog-owned provider asset bytes and says Source Observations are the review and promotion slice.
- Current TCGDex import writes object keys with provider, language, and external card identity through `tcgdexAssetObjectBaseKey`, e.g. `catalog/source-observations/tcgdex/{language}/{cardId}`. This violates the privacy-preserving URL intent.
- Current promotion copies the Source Observation's existing `normalized.imageUrls` and `normalized.productAssetSet` directly onto the new Catalog Item. That means promoted Catalog Items continue to publish Source Observation storage paths instead of item-owned `catalog/items` paths.
- Current import UI sends one blocking POST to `/imports/tcgdex-set` and only exposes button loading state. A real progress bar needs either a streaming response or asynchronous import job state; a normal POST cannot report per-card progress to the UI.
- Decision from user: prefer showing TCGDex CDN imagery while records are still Source Observations, then generate Chase Sets CDN assets on promotion. If Source Observations need post-promotion imagery, point them at the promoted Catalog Item-owned asset location rather than keeping separate Source Observation bucket copies.

## Open Questions

- None currently blocking.

## Implementation Checklist

- [x] Reuse isolated worktree `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-fix-tcgdex-source-observation-images`.
- [x] Confirm Catalog ownership and structure rules.
- [x] Locate current object storage ACL patch.
- [x] Locate current privacy leak in TCGDex asset key generation.
- [x] Locate current promotion behavior that publishes Source Observation asset URLs on Catalog Items.
- [x] Locate current import UI limitation: blocking POST with button loading only.
- [x] Resolve Source Observation temporary object retention/delete policy.
- [x] Stop mirroring TCGDex image assets into Chase Sets asset storage during Source Observation import.
- [x] Keep provider image URLs only as Source Observation provenance/display data before promotion.
- [x] On promotion, download the provider source asset, write a new Catalog Item-owned Product Asset Set under `catalog/items/{catalog_item_id}` and publish only those URLs on the Catalog Item.
- [x] Keep source/provider URL details in Source Observation provenance fields, not public asset object keys.
- [x] Keep or complete the object-storage public-read ACL regression.
- [x] Add progress reporting for TCGDex set import.
- [x] Update UI import dialogs to show a design-system progress bar during import.
- [x] Add focused runtime, route/client, UI, and object-storage tests.
- [x] Update durable Catalog Source Observation integration docs.
- [x] Run focused verification.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` so it explicitly states that provider-derived URLs are provenance, temporary Source Observation storage keys are opaque, and promoted Catalog Items publish only `catalog/items` asset URLs.
- No separate asset lifecycle note is needed for this pass because Source Observation import no longer creates temporary Chase Sets bucket objects.

## Verification

- `pnpm --filter @chase-sets/catalog test -- features/source-observations/api/tcgdex-client.test.ts features/source-observations/api/route.test.ts features/source-observations/domain/domain.test.ts features/source-observations/ui/source-observation-list-page.test.tsx features/source-observations/ui/integration-management-page.test.tsx`
- `pnpm --filter @chase-sets/catalog test`
- `pnpm --filter @chase-sets/object-storage test -- --run`
- `pnpm run verify:typecheck`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
