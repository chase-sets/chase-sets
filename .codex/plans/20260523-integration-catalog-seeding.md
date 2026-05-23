# Integration Catalog Seeding

## Intent

Make Catalog Integrations the operator home for seeding provider-backed catalog data. Admins should be able to pull provider scopes, promote eligible observations from the same page, resync a provider set, and reapply current provider mapping to already promoted Catalog Items without leaving the integration workflow.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260523-integration-catalog-seeding`
- Branch: `codex/integration-catalog-seeding`
- Sandbox id: `e37482fa`
- Dependency setup status: complete via `pnpm run deps:install`.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none found during planning setup.

## Owning Contexts

- Catalog owns the change.
- Owning slice: `bounded-contexts/catalog/features/source-observations`
- Supporting surfaces: Catalog admin route `bounded-contexts/catalog/routes/admin/integrations.tsx`, Catalog shell API client, localization copy, and Catalog source-observation docs.
- Deployables should remain thin composition roots through existing Catalog route and shell contributions.
- Discovery, Inventory, Marketplace, Checkout, Ordering, and Pricing stay downstream consumers of promoted Catalog facts; they should not receive provider import or promotion commands.

## Repo Evidence

- `bounded-contexts/README.md` says Catalog owns canonical product references and cross-context interaction must use stable IDs and published facts.
- `bounded-contexts/catalog/README.md` says Catalog owns provider Source Observations before review and promotion into canonical Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` defines Source Observation as a provider-sourced candidate record reviewed before it becomes Catalog truth.
- `bounded-contexts/catalog/context.json` declares `source-observations` as the provider observation, review, and promotion slice, and contributes both `integrations` and `source-observations` admin routes.
- `docs/adr/0003-environment-bootstrap-and-scenario-data.md` and `docs/architecture/environment-data-profiles.md` say staging and production provider imports are operator-triggered; bootstrap installs capability but does not import, promote, or publish provider content.
- `bounded-contexts/catalog/docs/source-observation-integration.md` already documents import, filter-scoped promote-all, resync by re-import, and mapping reapply policies.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx` already has selected promotion, promote-all matching, import, and active bulk job resume behavior.
- `bounded-contexts/catalog/features/source-observations/ui/integration-management-page.tsx` currently has import-one-expansion and reapply-promoted-current-filter actions, but no promote-all action and no row-level resync/reapply action.
- `bounded-contexts/catalog/features/source-observations/api/route.ts` exposes single-set import, promote-all preview/execution, reapply preview/execution, and integration scope queries.
- `bounded-contexts/catalog/features/source-observations/read-model/queries.ts` can summarize integration scopes by provider, language, expansion, and series, and can enumerate matching observation IDs for promotion/reapply.
- Existing plans `20260516-bulk-promote-source-observations.md`, `20260518-integration-query-import.md`, `20260517-tcgdex-catalog-integration-management.md`, and `20260521-reapply-source-integrations.md` show the current behavior was intentionally split across Source Observations and Integrations. This request should consolidate the admin seeding workflow on Integrations.

## Resolved Decisions

- Ownership: Catalog Source Observations owns the full workflow because provider observations, source hashes, promotion, mapping reapply, and linked Catalog Item refresh are Catalog behavior.
- Canonical UI home: make Catalog Integrations the operator workflow for provider-level catalog seeding, with Source Observations remaining the record-level review surface.
- Language: keep formal `Source Observation` for record state and use operator-facing actions such as `Pull`, `Promote all`, `Resync set`, and `Sync promoted` on the integration page.
- Promotion invariant: promote-all from Integrations must still use the existing review-scoped promotion path and confirmation preview. It must not silently promote every provider record globally.
- Resync invariant: resyncing a set means re-importing the provider Expansion scope. Unchanged provider facts remain idempotent; changed promoted observations move to `changed` for review.
- Repromote/sync invariant: syncing promoted records means reapplying current integration mapping to Source Observations already linked to Catalog Items. It must preserve `catalog_item_id` and Product identity and must not create replacement Catalog Items.
- Row scope: per-set actions should use provider, language, and Expansion scope derived from the integration scope row, not hidden last-import session state.
- Pull-all scope: default to importing every TCGdex Expansion for the selected language, with an optional Series filter available in the confirmation flow. This is broad enough for catalog seeding while avoiding all-language duplication.
- Bulk execution: pull-all, promote-all, row resync, and sync-promoted must be background jobs. The browser may enqueue jobs and watch progress/status, but it must not run long provider imports, promotion loops, or reapply loops in the client request lifecycle.

## Open Questions

- None blocking.

## Recommended Answer

Import every TCGdex Expansion for a selected language, with an optional Series filter in the confirmation dialog. This best matches "all new series/sets" as an admin seeding action, keeps the default workflow useful for initial catalog bootstrap, and still lets operators narrow the blast radius when they only want one series.

## Consequence Of Choosing Differently

If we limit "pull all" to one selected Series, the first full-catalog seed remains repetitive because admins must run the action once per Series. It is safer per click, but less aligned with the requested easy catalog seeding workflow. If we import every supported language by default, scope and volume become too broad for the current TCGdex-first implementation and make duplicate language-specific observations likely before the UI has strong language policy.

## Implementation Checklist

- [x] Resolve the pull-all scope question.
- [x] Install dependencies in the worktree with `pnpm run deps:install`.
- [x] Run `pnpm run sandbox:doctor` and record the sandbox id.
- [x] Add API/runtime support for bulk provider scope import if the chosen pull-all scope cannot be composed safely in the existing UI.
- [x] Ensure bulk provider import, promote-all, set resync, and promoted sync enqueue background jobs and are processed server/worker-side rather than by client-side loops.
- [x] Add Catalog shell client and UI hooks for the new import action.
- [x] Update `IntegrationManagementPage` with an operator-first layout: pull provider scopes, promote all eligible observations, row-level resync, row-level sync promoted, review link, progress, and confirmation previews.
- [x] Preserve source-observation list behavior and reuse existing promote/reapply APIs where possible.
- [x] Add focused API, runtime, read-model, and UI tests for pull-all, promote-all from Integrations, row resync, and row sync promoted.
- [x] Update Catalog source-observation docs if the implemented pull-all semantics add new durable policy.
- [x] Run focused Catalog tests, Catalog typecheck, localization, structure, and broader verification required by the change.
- [x] Browser-verify the admin Integrations page on desktop and mobile after implementation.

## Documentation To Promote

- `bounded-contexts/catalog/docs/source-observation-integration.md` if pull-all semantics, row-level set resync, or integration-page promote-all policy need durable wording.
- No ADR expected unless the decision shifts to automatic promotion or bootstrap-time provider import in staging/production.

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
