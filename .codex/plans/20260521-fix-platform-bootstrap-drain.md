# Fix Platform Bootstrap Drain

Date: 2026-05-21

## Context

- Worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-fix-platform-bootstrap-drain`
- Branch: `codex/fix-platform-bootstrap-drain`
- Prior deploy fix: PR #251 merged as `85b13e9d`, which skips stale automatic deployments cleanly and gates production on an actual staging deployment.
- Live staging run `26245839816` still hangs in DigitalOcean `platform-bootstrap` after Catalog seed reconciliation logs `catalog projections up to date.`

## Repo Evidence

- `.codex/plans/20260521-projection-rebuild-replay.md` added projection group revisions and automatic catch-up/rebuild during projection sync.
- `.codex/plans/20260521-admin-bulk-job-streaming.md` moved Catalog bulk Source Observation work to worker-owned jobs.
- `.codex/plans/20260521-admin-bulk-job-resume.md` records the first staging failure after the Source Observation job work as a long DigitalOcean Terraform apply wait.
- `docs/adr/0003-environment-bootstrap-and-scenario-data.md` says staging and production run only `critical-bootstrap` and `catalog-integration-bootstrap`; provider imports and scenario data are not bootstrap work there.
- `infrastructure/platform-runtime/api.ts` still drains the entire API runtime after each context seed and once more at the end, even when the environment is staging or production.
- The first bounded-drain fix still allowed staging to begin bootstrap-required projection synchronization for later contexts whose seeds are skipped under long-lived data profiles. The live deployment remained stopped after Catalog seed logs.
- The second bounded-drain fix skipped unseeded contexts, but the live deployment still stopped after Catalog seed logs, which points to host-level projection sync around a seeded long-lived context.

## Decision

Long-lived environment bootstrap should remain bounded to schema setup and seed reconciliation. It should not run host-level projection synchronization, subscriptions, projectors, outboxes, workflows, or projection groups as part of DigitalOcean pre-deploy.

Use the existing data profile split as the policy boundary:

- When `scenario-seed` is enabled, keep full runtime drains so dev, preview, and tests preserve the existing scenario behavior.
- When `scenario-seed` is not enabled, run enabled context seeds only. Context-owned seed routines may drain their own local projectors, but the platform host must not add cross-context catch-up work.

## Implementation Checklist

- [x] Add platform runtime bootstrap policy helpers for scenario-capable versus long-lived data profiles.
- [x] Update `seedApiHostIfEmpty` so long-lived profiles skip full runtime drains and use required projection synchronization after seed work.
- [x] Skip projection synchronization entirely for contexts whose seed does not run under the active data profiles.
- [x] Skip host-level projection synchronization around long-lived context seeds.
- [x] Add focused platform-runtime tests proving production-like profiles avoid host-level drains while scenario profiles still run full drains.
- [x] Update the DigitalOcean deployment runbook with the bounded bootstrap behavior.
- [x] Run targeted and static verification.
- [ ] Submit PR, wait for CI, merge, and verify staging then production deployments green.

## Verification

- `pnpm run deps:install`: passed.
- `pnpm run sandbox:doctor`: passed with sandbox id `3eecaf4f`.
- `pnpm --filter @chase-sets/platform-runtime run test`: passed.
- `pnpm --filter @chase-sets/platform-runtime run typecheck`: passed.
- `pnpm exec prettier --check infrastructure/platform-runtime/api.ts infrastructure/platform-runtime/index.test.ts docs/runbooks/digitalocean-platform-deployment.md .codex/plans/20260521-fix-platform-bootstrap-drain.md`: passed.
- `pnpm run check:no-any`: passed.
- `pnpm run verify:static`: passed.
- `git diff --check`: passed.
