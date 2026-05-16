# TCGDex Asset Storage

## Intent

Move TCGDex card assets into Chase Sets-owned storage during the Catalog Source Observation workflow so promoted Catalog Item `image_urls` no longer point directly at `assets.tcgdex.net`.

For this pass, only the high quality TCGDex asset should be mirrored and carried forward. The low quality asset should not be imported, stored, promoted, or displayed from the TCGDex workflow.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-tcgdex-asset-storage`
- Branch: `codex/tcgdex-asset-storage`
- Created from current repo `main` at `8cc4f1e6`.
- Dependency setup: `pnpm run deps:install` succeeded on 2026-05-16.
- Sandbox doctor: succeeded on 2026-05-16.
- Sandbox id: `925164c3`.
- Local URLs: admin web `http://localhost:8552`, marketplace `http://localhost:8553`, platform API `http://localhost:8562`.
- Setup caveat: this worktree was created from current `main`, but the working TCGDex Source Observation implementation is not present on that base. Evidence was read from existing worktree `D:\Users\ToddS\Source\Repos\chase-sets-20260515-catalog-tcgdex-integration` at `fe037fb0` on branch `codex/catalog-tcgdex-integration`. Implementation should either rebase this planning branch onto that integration work or recreate the implementation branch from it before product code changes.

## Owning Contexts

- Catalog owns this change.
- Catalog already owns Catalog Item `image_urls`, Source Observations, provider keys, external keys, source record hashes, review status, and promotion into Catalog Items.
- Discovery is downstream only. It projects `catalog.catalog-item.image-urls-set` and should receive Chase Sets-owned URLs without knowing whether they came from TCGDex, local storage, or DigitalOcean Spaces.
- Shared infrastructure may own a reusable object storage adapter if more contexts will later store owned assets, but provider import policy and asset selection remain Catalog Source Observation behavior.

## Resolved Decisions

- Canonical term: keep `Source Observation` for provider-fed candidate facts. Add `Catalog Asset` or `Mirrored Asset` only if implementation needs durable asset metadata beyond a URL.
- Asset mirroring belongs in the Catalog `source-observations` workflow before recording normalized candidate facts, not in Discovery and not in deployables.
- TCGDex should produce only the high quality asset URL for now. Existing evidence shows `tcgdex-client.ts` currently emits both `${image}/low.webp` and `${image}/high.webp`; this should change to high only.
- Promotion should set Catalog Item `image_urls` from the mirrored high quality URL, not the TCGDex URL.
- Provider provenance should keep the TCGDex source API URL, provider key, external key, and sanitized source payload. The mirrored asset URL should be Catalog-owned presentation data; the original TCGDex asset base may remain in provenance only if needed for audit/debug.
- The asset mover should be idempotent by deterministic object key, so re-importing the same observed provider record does not duplicate objects.
- Source record hashing should not churn solely because the public Chase Sets asset host changes. Prefer hashing provider facts plus the selected original high-quality asset source, while storing mirrored URL in normalized candidate data after a successful mirror.
- Local/testing mirrored assets should use a filesystem-backed object storage adapter under ignored worktree artifacts, exposed through the same public URL shape as production.
- If TCGDex provides an image URL but the high quality asset cannot be downloaded or stored, fail that Source Observation instead of recording an observation with a TCGDex display URL. Missing provider image data remains valid and should record an observation with no image URLs.

## Open Questions

- None.

## Implementation Checklist

- Base implementation work on the branch/worktree that contains `source-observations`, or merge that work before product edits.
- Introduce a small provider-neutral asset storage port for Catalog Source Observation runtime, with implementations for local filesystem-backed storage and DigitalOcean Spaces-compatible S3.
- Inject the asset storage port through Catalog runtime composition, keeping deployables as thin composition roots.
- Update the TCGDex importer to derive the high quality source URL only: `${card.image}/high.webp`.
- Download the high quality asset during import and write it through the storage port using a deterministic key such as `catalog/source-observations/tcgdex/{languageCode}/{externalKey}/high.webp`.
- Fail the observation when the provider declares an image but the high quality asset cannot be mirrored.
- Store or return the Chase Sets-owned public URL from the storage port and place only that URL in `normalized.imageUrls`.
- Preserve source provenance without treating the TCGDex asset URL as the display URL.
- Keep promotion unchanged in shape where possible: `SetCatalogItemImageUrls` should receive `normalized.imageUrls`, now containing the mirrored high quality URL.
- Make missing TCGDex image data a valid observation with empty `imageUrls`, matching current policy.
- Add tests for TCGDex high-only mapping, successful mirroring, idempotent re-import, missing image behavior, failed download/storage behavior, and promotion copying mirrored URLs.
- Update `bounded-contexts/catalog/docs/source-observation-integration.md` to say TCGDex assets are mirrored into Chase Sets-owned storage and only high quality webp is imported for now.
- Add or update an operations/runbook note for required production asset storage environment variables once the adapter names are finalized.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` because this is Catalog-owned provider import policy.
- Update `docs/README.md` only if a new cross-cutting asset storage runbook or architecture document is added.
- Consider an ADR only if the implementation chooses a system-wide object storage contract that other contexts will consume immediately.

## Implementation Status

- Merged the existing TCGDex Source Observation integration base from `codex/catalog-tcgdex-integration` before product edits.
- Added `@chase-sets/object-storage` with filesystem and S3-compatible adapters, deterministic key normalization, public URL construction, and local filesystem reads for development asset serving.
- Added a Catalog `catalogAssetStorage` host port and wired it through Catalog runtime composition from `admin-support-api` and `platform-api`.
- Updated the TCGDex import workflow to download only `{card.image}/high.webp`, store it under `catalog/source-observations/tcgdex/{languageCode}/{externalKey}/high.webp`, and record the Chase Sets-owned public URL in normalized image URLs.
- Kept missing provider image data valid with empty `imageUrls`; declared image download/storage failures now fail the import instead of falling back to TCGDex display URLs.
- Kept Source Observation hashes based on provider facts plus the original selected TCGDex high-quality asset URL, so changing the Chase Sets public asset host does not churn source hashes.
- Updated admin Source Observation review UI to display the single high-quality normalized image URL.
- Added local filesystem defaults and production S3/DigitalOcean Spaces-compatible configuration to `platform-api` and `admin-support-api`; production rejects filesystem-backed asset storage.
- Promoted docs in `bounded-contexts/catalog/docs/source-observation-integration.md`, `docs/runbooks/catalog-asset-storage.md`, and `docs/README.md`.

## Verification

- `pnpm --filter @chase-sets/object-storage run test`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm --filter @chase-sets/catalog run test -- features/source-observations/api/tcgdex-client.test.ts`
- `pnpm --filter @chase-sets/app-platform-api run test:fast -- __tests__/config.test.ts`
- `pnpm --filter @chase-sets/app-admin-support-api run test:fast -- __tests__/config.test.ts`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`
- `pnpm run verify:build`
- `pnpm run verify:test`
- Local platform API filesystem asset route returned `image/webp` and immutable cache headers for a seeded test `high.webp` under `/catalog-assets/...`.
- Browser plugin verification was attempted against local platform API routes but returned `net::ERR_BLOCKED_BY_CLIENT`; HTTP-level verification was used for the asset route.

## Goal Completion Criteria

The implementation goal must:

- Use the implementation worktree path and branch recorded here, adjusted to the TCGDex integration base before product edits.
- Implement Catalog-owned TCGDex asset mirroring with local filesystem storage for tests and DigitalOcean Spaces-compatible S3 for shared environments.
- Keep only the high quality TCGDex asset in imported observations and promoted Catalog Item `image_urls`.
- Preserve Source Observation review-first behavior and provider provenance.
- Promote durable docs for the chosen storage behavior.
- Run focused Catalog tests plus relevant static/type checks.
- Run browser or visual verification for admin Source Observation review and downstream marketplace item imagery if UI behavior is touched.
- Submit a PR, wait for passing CI, merge it, verify staging deployment, and retain this plan in the repo history.
