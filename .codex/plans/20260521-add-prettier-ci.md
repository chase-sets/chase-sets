# Add Prettier CI Check

## Intent

Add Prettier as the repository formatter and make formatting drift fail the existing CI static checks. Keep the change scoped to workspace automation and formatting configuration; no product, bounded-context runtime, schemas, or UI behavior changes are intended.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-add-prettier-ci`
- Branch: `codex/add-prettier-ci`
- Sandbox id: `3ee79073`
- Dependency setup status: `pnpm run deps:install` completed on 2026-05-21.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found.

## Owning Contexts

Formatting is owned by root workspace automation and CI. No business bounded context owns this behavior. The bounded-context map says contexts own business behavior, read models, UI, and tests, while repository automation lives under root scripts and CI workflows.

## Resolved Decisions

- Use Prettier at the root as a repo-wide developer tooling dependency.
- Add `format` for local writes and `format:check` for non-mutating validation.
- Include `format:check` in `verify:static` so the existing Platform PR `static` job enforces formatting.
- Keep Prettier configuration at the repository root so all bounded contexts, contracts, infrastructure packages, deployables, docs, and scripts share one standard.
- Keep generated workspace metadata formatter-ignored because `sync:workspace-metadata` owns exact bytes and `verify:metadata` is the canonical drift check for those files.
- Avoid durable architecture docs for this change; the scripts and CI wiring are the durable source of truth.

## Open Questions

None.

## Implementation Checklist

- [x] Add Prettier dev dependency.
- [x] Add root Prettier config and ignore file.
- [x] Add package scripts for formatting and check-only formatting.
- [x] Wire `format:check` into `verify:static`.
- [x] Run Prettier once so existing tracked code conforms.
- [x] Verify `pnpm run format:check` and focused static checks.

## Verification

- `pnpm run deps:install` completed.
- `pnpm run sandbox:doctor` completed with sandbox id `3ee79073`.
- `pnpm run format:check` passed.
- `pnpm run verify:static` passed.
- `pnpm run verify:metadata` initially failed in PR CI because Prettier and `sync:workspace-metadata` disagreed on generated output bytes; generated metadata is now excluded from Prettier and checked by `verify:metadata`.
- `pnpm run verify:typecheck` passed.

## Documentation To Promote

None. This is an infrastructure/developer workflow change and does not introduce new domain language, bounded-context ownership, or operational deployment behavior.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
