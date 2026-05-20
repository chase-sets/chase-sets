# Bulk Action Progress Bars

## Intent

Promote all matching Source Observations can take long enough that a spinner-only button looks stuck. Bulk actions that process records should expose progress through a progress bar, starting with the Source Observation promotion/rejection flows that already process records one at a time.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-bulk-action-progress-bars`
- Branch: `codex/bulk-action-progress-bars`
- Sandbox id: embedded worktree under `.codex/worktrees/20260520-bulk-action-progress-bars`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none; `pnpm run sandbox:doctor` passed with sandbox id `5ea24a7a`

## Owning Contexts

- Catalog owns Source Observations, review status, and promotion into Catalog Items.
- Catalog Source Observations slice owns the API, runtime behavior, read-model scope, UI, and tests for promote/reject bulk actions.
- The design system owns the reusable `ProgressBar` component; no custom UI override should be added outside canonical components.

## Resolved Decisions

- Ownership: Catalog Source Observations owns this behavior because the slow action is Source Observation promotion/rejection, and Catalog docs state Source Observations and promotion are Catalog-owned review behavior.
- Language: use existing Catalog terms: Source Observation, observed, promoted, rejected, matching records, eligible observations.
- Invariants: progress tracking must not change promotion eligibility, retry behavior, skip/fail semantics, or the per-observation Catalog behavior.
- Events: no new domain or integration events are needed; progress is operational UI feedback emitted while existing commands run.
- Read models: no persistent progress read model is needed; progress is request-scoped and streamed to the browser.
- API: add progress-stream endpoints beside existing bulk promote/reject endpoints, following the existing TCGdex import NDJSON pattern.
- UI: running bulk actions render a design-system `ProgressBar`; Source Observation bulk operations use determinate progress from streamed processed/total counts.
- Operations: if streaming is unavailable or errors mid-run, surface the same toast error path and avoid pretending completion.

## Implementation Checklist

- Complete: Add request-scoped bulk progress types to Source Observation runtime/client contracts.
- Complete: Stream progress for bulk promote and bulk reject routes.
- Complete: Extend the Catalog API client and Source Observation UI functions to accept progress callbacks.
- Complete: Replace spinner-only running states for Source Observation bulk actions with visible progress bars in the bulk bar and confirmation dialog.
- Complete: Add focused UI/API tests for progress events and rendered progress bars.
- Complete: Run dependency setup, sandbox doctor, targeted tests, typecheck, localization check, design-system tests, and a browser smoke of the Source Observations page.

## Documentation To Promote

- No durable architecture docs required unless implementation exposes a broader cross-context bulk progress policy.
- Keep this plan committed with the implementation.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
