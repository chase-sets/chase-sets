# Staging Reset CDN State Parse

## Intent

Fix the Platform Staging Reset workflow so stale DigitalOcean CDN state is removed before `terraform destroy` when the CDN endpoint has already disappeared from DigitalOcean.

## Worktree

- Path: `.codex/worktrees/20260523-staging-reset-cdn-state-parse`
- Branch: `codex/staging-reset-cdn-state-parse`
- Sandbox id: not created; no runtime sandbox needed for a workflow-only change
- Dependency setup status: not needed unless verification requires workspace scripts
- pnpm store path: default worktree store if dependencies are installed
- Setup blockers: none

## Owning Contexts

- Operational surface: `.github/workflows/platform-staging-reset.yml`
- Infrastructure surface: `infrastructure/digitalocean/catalog-assets`
- Catalog asset infrastructure serves Catalog-owned provider imagery, but this change does not alter Catalog domain behavior.

## Resolved Decisions

- Keep the fix scoped to the staging reset workflow.
- Preserve the existing destructive reset sequence.
- Treat DigitalOcean 404 for the CDN as stale Terraform state and remove only `digitalocean_cdn.catalog_assets` before destroy.
- Read the CDN ID from structured Terraform state via `terraform state pull | jq` instead of scraping `terraform state show` output.

## Implementation Checklist

- Update stale CDN state reconciliation. Done.
- Verify workflow syntax/static checks.
- Push a PR for review/CI.

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
