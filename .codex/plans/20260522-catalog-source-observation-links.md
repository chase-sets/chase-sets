# Catalog Source Observation Links

## Intent

Ensure Source Observation promotion is idempotent against existing source-populated Catalog Items. A promoted source should either refresh the linked Catalog Item or create one new Catalog Item with a durable source reference that future promotion can resolve.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260522-catalog-source-observation-links`
- Branch: `codex/catalog-source-observation-links`
- Sandbox id: `5d039727`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found during planning

## Owning Contexts

- Catalog owns Catalog Item identity, Source Observations, Source Observation review policy, and external product references.
- Source Observations live in `bounded-contexts/catalog/features/source-observations`.
- Catalog Item source references live in `bounded-contexts/catalog/features/catalog-items`.

## Resolved Decisions

- Source Observation promotion should resolve an existing Catalog Item from the Catalog-owned external product reference before generating a new `catalog_item_id`.
- The stable source key for TCGdex promotions remains `provider_key` plus the language-scoped external key currently written by promotion, for example `tcgdex` and `en:me02.5-136:reverse-holo`.
- Existing Catalog Items in `archived` or `removed` state must not be refreshed by source promotion; promotion creates a new item in that case.
- A promoted Source Observation can be promoted again as an explicit resync operation when it still has a linked Catalog Item.
- The Catalog Item detail page and list source-provider filters already expose the source link through `external_product_references` and `source_providers`; no new UI surface is required for this acceptance pass.
- No glossary conflict found. The user's "retired or deleted" maps to historical `retired` events replaying as `archived`, and removed draft items using `removed`.

## Implementation Checklist

- [x] Add a source-reference lookup in the Source Observation runtime.
- [x] Use the lookup before creating a new Catalog Item for an `observed` Source Observation.
- [x] Refresh the resolved Catalog Item when an existing active or draft item is found.
- [x] Allow explicit promotion of an already `promoted` Source Observation to resync its linked Catalog Item without creating a replacement.
- [x] Keep archived/removed Catalog Items out of source-reference reuse.
- [x] Cover duplicate-prevention and repromotion behavior in focused tests.

## Documentation To Promote

- Updated `bounded-contexts/catalog/docs/source-observation-integration.md` to document source-reference reuse and explicit promoted-observation resync.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
