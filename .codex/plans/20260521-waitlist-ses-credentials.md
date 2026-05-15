# Waitlist SES Sender Credentials

## Intent

Finish PR #101 so deployed waitlist confirmation email can send through Amazon SES now that real SES sender credentials are available.

The PR should keep Public Presence as the owner of waitlist signup behavior and confirmation intent, keep Notifications as the owner of account notification policy, and keep `platform-worker`/DigitalOcean/GitHub Actions as thin runtime and infrastructure composition.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-waitlist-admin-review`
- Branch: `codex/waitlist-ses-credentials`
- PR: `https://github.com/todd-skelton/chase-sets/pull/101`
- Base checked: freshly fetched `origin/main` on 2026-05-21.
- Sandbox id: `5f5fde9b`.
- Dependency setup status: `pnpm run deps:install` completed successfully.
- pnpm store path: `D:\Users\ToddS\Source\Repos\.chase-sets-pnpm-store`.
- Setup blockers: none found during planning.

## Owning Contexts

- Public Presence owns Waitlist Signup behavior and the waitlist confirmation transactional email source fact.
- Notifications owns account-level notification delivery policy and the Notification Center, not anonymous waitlist signup confirmation.
- `platform-worker` provides the host port/runtime composition for the transactional email gateway.
- `infrastructure/digitalocean/platform` owns App Platform environment variable composition.
- GitHub Actions workflows own environment-secret pass-through and deploy-time validation.

## Resolved Decisions

- Keep the PR. Current `origin/main` does not provide `SES_AWS_ACCESS_KEY_ID` or `SES_AWS_SECRET_ACCESS_KEY` to Terraform or `platform-worker`, so enabling `NOTIFICATION_EMAIL_PROVIDER=amazon-ses` would still fail or rely on unavailable ambient AWS credentials.
- Add explicit SES IAM sender credentials as GitHub Environment secrets in `preview`, `staging`, and `production`; the user confirmed credentials now exist.
- Fail fast when `NOTIFICATION_EMAIL_PROVIDER=amazon-ses` and any SES value is missing, including the access key id and secret key.
- Pass credentials to the SES v2 client through `createSesSendRequest` rather than changing Public Presence waitlist behavior.
- Treat this branch as infrastructure/runtime completion for the already-built waitlist confirmation flow.

## Open Questions

None blocking.

## Implementation Checklist

- Rebase or merge `codex/waitlist-ses-credentials` onto current `origin/main`.
- Resolve any drift from newer workflow, Terraform, or platform-worker changes without dropping the SES credential wiring.
- Verify workflow validation includes both `TF_VAR_ses_aws_access_key_id` and `TF_VAR_ses_aws_secret_access_key` in preview, staging, and production paths.
- Verify Terraform exposes `ses_aws_access_key_id` and `ses_aws_secret_access_key` as sensitive variables and injects them into the `platform-worker` component.
- Verify worker config requires the two credentials when Amazon SES is enabled.
- Verify worker SES gateway and notification adapter pass explicit credentials into the SES client.
- Update runbooks to document the new environment secrets and operational rotation path.

## Documentation To Promote

- Keep the updated email operations and DigitalOcean platform deployment runbooks with the PR.
- No glossary update is needed; no new domain term is introduced.
- No ADR is needed; explicit provider credentials are routine infrastructure configuration.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed.
- `git diff --check origin/main...HEAD` passed before final plan commit.
- `pnpm --filter @chase-sets/app-platform-worker run test` passed.
- `pnpm --filter @chase-sets/app-platform-worker run typecheck` passed.
- `pnpm --filter @chase-sets/ses-email run test` passed.
- `terraform -chdir=infrastructure/digitalocean/platform fmt -check -recursive` passed.
- `pnpm run check:structure` passed.
- `pnpm run verify:metadata` passed.
- `pnpm run check:no-any` passed.
- `pnpm run test:workspace-metadata` passed.
- `pnpm run verify:static` passed after formatting the rebase resolution.
- `pnpm run verify:typecheck` passed.

## Review Outcome

- The branch should not be tossed. Current `origin/main` still lacks the explicit SES sender credential path.
- The branch was rebased onto current `origin/main`; conflicts were limited to platform-worker SES config/gateway areas affected by newer mobile messaging config.
- The final branch preserves newer main behavior and adds only the SES credential wiring needed for Amazon SES delivery.

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
