# Amazon SES Email Platform

## Intent

Complete Amazon SES setup as the Chase Sets email platform across preview, staging, and production so configured environments can send real transactional email through SES instead of the current noop gateway.

Scope includes deployment wiring, worker composition, SES provider integration, tests, durable operational docs, and staging verification after merge. Scope does not include marketing campaign orchestration or SMS/RCS work.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-amazon-ses-email-platform`
- Branch: `codex/amazon-ses-email-platform`
- Base: current `main` at worktree creation, `8cc4f1e6`
- Sandbox id: `0ae19b35`
- Sandbox port base: `10850`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox check: `pnpm run sandbox:doctor` completed.
- Setup caveats: local Node is `v24.15.0` while repo docs mention Node `26.1.0`; dependency install completed successfully.

## Owning Contexts

- **Notifications** owns notification delivery policy, notification settings, and centralized notification-center feed behavior.
- **Auth**, **Ordering**, and **Fulfillment** own existing transactional email intents for their source facts.
- **Infrastructure** owns provider adapters: SES API delivery, provider error mapping, provider-level retry behavior, SNS notification parsing, and provider-specific clients.
- **Deployables** remain thin composition roots. `platform-worker` should select the configured provider and compose dispatchers; it must not own email business behavior.
- **DigitalOcean Terraform/GitHub Actions** own deployed environment propagation into App Platform components.

## Resolved Decisions

- Use Amazon SES for transactional email, with marketing deferred until operational reliability is proven.
- Keep provider details in `infrastructure/ses-email`; source contexts enqueue provider-agnostic transactional email messages.
- Keep the durable transactional email outbox as the reliability boundary between event projectors and provider sends.
- Use these already-created SES identities:
  - Production: `notifications@chasesets.com`, identity ARN `arn:aws:ses:us-east-2:812517519777:identity/chasesets.com`, configuration set `transactional-production`.
  - Staging: `notifications@staging.chasesets.com`, identity ARN `arn:aws:ses:us-east-2:812517519777:identity/staging.chasesets.com`, configuration set `transactional-staging`.
  - Preview: `notifications@preview.chasesets.com`, identity ARN `arn:aws:ses:us-east-2:812517519777:identity/preview.chasesets.com`, configuration set `transactional-preview`.
- GitHub Environment variables/secrets have already been populated for `preview`, `staging`, and `production`; Terraform/workflows still need to consume them.
- Existing DNS records for production, staging, and preview DKIM, MAIL FROM, and DMARC have been added to DigitalOcean and verified from DigitalOcean authoritative DNS.
- Use the official AWS SES SDK for production sends. This adds a standard provider client, avoids bespoke AWS request signing, and keeps the existing `sendRequest` injection point for tests.

## Repo Evidence

- `docs/architecture/email-delivery-strategy.md` says SES should be the day-one transactional provider and provider details belong in `infrastructure/`.
- `docs/architecture/notifications-channel-and-provider-recommendation.md` says email + in-app should be the default channel ladder, with SES as email system of record.
- `bounded-contexts/notifications/README.md` says Notifications owns delivery policy/settings/feed, but not provider infrastructure adapters.
- `bounded-contexts/auth/context.json` and `bounded-contexts/notifications/context.json` expose `transactionalEmailOutbox` and `notificationOutbox` host ports provided by `platform-worker`.
- `deployables/platform-worker/src/config.ts` already parses `NOTIFICATION_EMAIL_PROVIDER` and `SES_*` values.
- `deployables/platform-worker/src/main.ts` currently composes `createNoopTransactionalEmailGateway()` and `createNoopNotificationAdapter("email")`, so configured SES values are not yet used.
- `infrastructure/ses-email/index.ts` maps provider-agnostic transactional messages to SES-shaped `SendEmail` requests, but it currently expects an injected `sendRequest` function.
- `infrastructure/digitalocean/platform/main.tf` does not yet pass SES env vars into `platform-worker`.
- `main` now deploys staging and production from `.github/workflows/platform-production.yml`; PR preview/staging/production Terraform validation lives in `.github/workflows/platform-pr.yml`.

## Implementation Evidence

- Added AWS SDK-backed `createSesSendRequest` in `infrastructure/ses-email/index.ts` while preserving injectable `sendRequest` for tests.
- Added SES SDK mapping coverage in `infrastructure/ses-email/index.test.ts`.
- Added `@aws-sdk/client-sesv2` to `@chase-sets/ses-email`.
- Added `@chase-sets/ses-email` to `@chase-sets/app-platform-worker`.
- `deployables/platform-worker/src/config.ts` now fails fast when `NOTIFICATION_EMAIL_PROVIDER=amazon-ses` lacks any required `SES_*` value.
- `deployables/platform-worker/src/main.ts` now composes SES transactional email and notification email adapters when configured, otherwise keeps noop email delivery.
- `infrastructure/digitalocean/platform/main.tf` now passes SES env vars into the `platform-worker` component.
- `.github/workflows/platform-production.yml` now passes staging and production SES GitHub Environment values into Terraform and validates them when SES is enabled.
- `.github/workflows/platform-pr.yml` now supplies PR-safe Terraform defaults for plan jobs and passes preview SES GitHub Environment values into the preview deployment job.
- Added `docs/runbooks/email-operations.md` and linked it from `docs/README.md`.
- Updated `docs/runbooks/digitalocean-platform-deployment.md` with SES environment variables/secrets and environment-specific values.
- Confirmed feature-worktree local `deployables/platform-worker/.env.local` uses the preview SES identity values.
- Confirmed GitHub Environments `preview`, `staging`, and `production` contain SES variables and the `SES_SOURCE_ARN` secret.

## Verification Evidence

- `pnpm --filter @chase-sets/ses-email run test`
- `pnpm --filter @chase-sets/app-platform-worker run test`
- `pnpm --filter @chase-sets/ses-email run typecheck`
- `pnpm --filter @chase-sets/app-platform-worker run typecheck`
- `pnpm run verify:metadata`
- `pnpm run verify:static`
- `pnpm run verify:typecheck`
- `pnpm run verify:test`
- `pnpm run verify:build`
- `terraform fmt -check -recursive`
- `terraform -chdir=infrastructure/digitalocean/platform validate -no-color`
- Backendless Terraform plan for preview App Platform with SES enabled and `notifications@preview.chasesets.com`.
- Backendless Terraform plan for staging App Platform with SES enabled and `notifications@staging.chasesets.com`.
- Backendless Terraform plan for production App Platform with SES enabled and `notifications@chasesets.com`.
- `actionlint` was not installed locally; workflow syntax will be covered by GitHub Actions after PR submission.

## Open Questions

- None currently blocking implementation.

## Implementation Checklist

- Add or choose the SES transport implementation for `infrastructure/ses-email`.
- Keep `sendRequest` injectable for unit tests and add a production factory that sends through SES v2.
- Add focused tests for SES factory request mapping and missing config behavior.
- Wire `platform-worker` transactional email dispatchers to SES when `NOTIFICATION_EMAIL_PROVIDER=amazon-ses`; otherwise keep noop.
- Wire notification email channel adapters to SES when configured while keeping web notifications on Postgres.
- Add production-like config validation so `amazon-ses` fails fast when required `SES_*` values are missing.
- Add `@chase-sets/ses-email` and any external SDK dependency to `deployables/platform-worker/package.json` only where needed.
- Add Terraform variables for `notification_email_provider`, `ses_aws_region`, `ses_from_email`, `ses_configuration_set_name`, and `ses_source_arn`.
- Pass SES variables into the `platform-worker` App Platform service in `infrastructure/digitalocean/platform/main.tf`.
- Update GitHub preview, staging, production, and PR workflows to set `TF_VAR_*` SES values from GitHub Environment variables/secrets or PR-safe defaults.
- Update deployment/runbook docs so future env setup and SES rollout are reproducible.
- Run focused unit tests for SES, platform-worker config, Terraform validation shape, and workflow lint where practical.
- Run broader verification before PR: metadata, static checks, typecheck, relevant tests, and build.

## Documentation To Promote

- Update `docs/runbooks/digitalocean-platform-deployment.md` with SES GitHub Environment variables/secrets and environment-specific sender values.
- Add or update an SES/email operations runbook section covering verified identities, configuration sets, MAIL FROM domains, bounce/complaint handling, and production smoke expectations.
- Update `docs/README.md` only if a new durable runbook/doc is added.

## Goal Completion Criteria

The implementation goal must:

- Implement SES sending in the feature worktree and keep provider behavior in `infrastructure/`.
- Keep deployables as thin composition roots with explicit env-driven provider selection.
- Promote durable SES setup/operations docs.
- Verify automated tests and builds relevant to infrastructure, worker config, Terraform, workflows, and email dispatch.
- Include any needed local smoke or controlled non-production send verification.
- Submit a PR from `codex/amazon-ses-email-platform`.
- Wait for CI to pass.
- Merge the PR after approval.
- Confirm staging deploy succeeds and `platform-worker` receives SES env vars.
- Retain this plan file in the merged changes.
