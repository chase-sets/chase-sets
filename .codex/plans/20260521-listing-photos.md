# Listing Photos

## Intent

Accounts can add seller photos to Marketplace listings. Publication must reject high-condition listings that require evidence photos, including Pristine and Mint product selections. Listing photo uploads are normalized into Chase Sets-owned WebP asset variants with bounded display sizes, then stored through the shared object-storage adapter backed by DigitalOcean Spaces in production-like environments and filesystem storage locally.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-listing-photos`
- Branch: `codex/listing-photos`
- Sandbox id: `ce68da41`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none currently; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Marketplace owns Listing behavior, lifecycle invariants, seller listing UI, listing read models, and listing photo metadata.
- Shared `@chase-sets/object-storage` remains the infrastructure adapter for filesystem and Spaces/S3-compatible object writes.
- `platform-api` remains a thin composition root for storage configuration and local filesystem asset serving.

## Resolved Decisions

- Use the natural term `Listing Photo` for seller-supplied listing imagery. Add it to the Marketplace glossary.
- Store photo metadata in Marketplace listing events and projections as normalized WebP asset-set records with keys, public URLs, sizes, hashes, and positions. Do not put raw bytes in the event stream.
- Add a `marketplace.listing.photos-added` event and command so photos can be attached after draft creation and replay into read models.
- Allow photos to be supplied during listing creation and in the existing create-and-publish account workflow so a seller can satisfy required-photo publication rules in one flow.
- Validate content type and size before normalization. Initial accepted source uploads are JPEG, PNG, and WebP; all stored listing-photo assets are WebP.
- Use the same trim-alpha display normalization posture and variant roles as Catalog product assets so seller photos get storage-saving WebP conversion and normalized display sizes.
- Treat product selections whose option code or label contains `pristine` or `mint` as requiring at least one listing photo before publication. `near_mint` / `Near Mint` does not require a photo.
- Store listing photo objects under `marketplace/listings/<accountId>/<listingId>/...` to keep ownership explicit inside the bucket.
- Add Marketplace-specific listing photo storage config in `platform-api` with local defaults and S3/Spaces production-like requirements, avoiding reuse of Catalog-specific env names.

## Implementation Checklist

- [x] Add Marketplace domain types, command, event, invariant, normalization, and tests for listing photos and high-condition publish requirements.
- [x] Extend listing read-model schema, projection, and queries to expose photo metadata.
- [x] Extend listing runtime with object-storage-backed photo attachment and publish validation.
- [x] Add API support for multipart listing photo uploads on create and attach-photo routes.
- [x] Wire listing photo storage through `platform-api` config/main and local filesystem route.
- [x] Update account listing UI forms and detail display using design-system components only.
- [x] Update API docs, localization, and Marketplace glossary.
- [x] Install dependencies, run sandbox doctor, and run focused tests/typecheck.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox `ce68da41`.
- `pnpm --filter @chase-sets/marketplace run test` passed.
- `pnpm --filter @chase-sets/app-platform-api run test -- config.test.ts` passed.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- account-listing account-listings` passed.
- `pnpm --filter @chase-sets/design-system run test` passed.
- `pnpm run verify:metadata` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:build` passed.
- `pnpm run verify:test` passed.
- PR #244 initial CI failed in `E2E Tests` because platform-api bootstrap published seeded Mint/Pristine listings without evidence photos.
- Updated Marketplace seed data to upload a normalized evidence photo for seeded listings that require it, and wired listing photo storage into platform-api bootstrap.
- `pnpm run dev:db:refresh` passed from a clean sandbox after the seed/bootstrap fix.
- `pnpm run test:e2e -- --workers=1` passed locally, matching CI's serial worker mode. A local parallel run had one sign-in transition failure while the web server and other flows passed.

## Documentation To Promote

- `bounded-contexts/marketplace/GLOSSARY.md`: add Listing Photo.
- `docs/api/marketplace.openapi.json`: document listing photo create/attach capability.
- `deployables/platform-api/.env.example`: document local and Spaces-backed Marketplace listing photo storage settings.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
