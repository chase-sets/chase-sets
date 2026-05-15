# Notification Channels

## Intent

Support email, SMS, RCS, web, push, and future notification channels without requiring source contexts, deployables, or provider-specific infrastructure to know about each other.

The update should preserve the bounded-context rule that Notifications owns delivery policy and preferences, source contexts publish facts or notification intents, contracts define stable message and channel envelopes, and infrastructure modules provide replaceable external provider adapters.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-notification-channels`
- Branch: `codex/notification-channels`
- Base: current source repo HEAD `8cc4f1e6 Add notifications database to staging platform (#72)`
- Sandbox id: `0610df92`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox status: `pnpm run sandbox:doctor` completed. Services are assigned to port base `6500`.
- Setup blockers: none.

## Owning Contexts

- Notifications owns account delivery policy, notification-center feed, notification preferences, and channel preference decisions.
- `contracts/notifications` owns the provider-agnostic notification message, channel, delivery, receipt, and adapter contracts shared between contexts and infrastructure.
- `infrastructure/notification-outbox` owns durable delivery storage and dispatcher mechanics.
- Channel provider adapters stay in provider-specific infrastructure packages such as `infrastructure/ses-email`, `infrastructure/web-notifications`, and future SMS/RCS/push packages.
- Deployables remain thin composition roots that wire configured adapters into the dispatcher.

Repo evidence:

- `bounded-contexts/README.md` lists Notifications as the owner of account notification center, notification settings, feed read state, and delivery policy.
- `bounded-contexts/notifications/README.md` says Notifications does not own source business facts or provider infrastructure adapters.
- `bounded-contexts/notifications/context.json` exposes a `notificationOutbox` host port provided by `platform-worker`.
- `contracts/notifications/index.ts` already defines message, delivery, outbox, adapter, receipt, and channel preference contracts, but currently limits channels to `email | web`.
- `infrastructure/notification-outbox/index.ts` stores one row per channel delivery but currently hard-codes the database channel check to `email | web`.
- `deployables/platform-worker/src/main.ts` composes the notification dispatcher with an email adapter and web adapter.

## Resolved Decisions

- Canonical channel names will include `email`, `sms`, `rcs`, `web`, and `push`.
- Provider names will become extensible strings with known provider constants rather than a closed union, so a new provider adapter can be introduced without changing every shared contract consumer.
- Channel payloads will stay discriminated by `channel`, with typed first-class payloads for email, SMS, RCS, web, and push.
- The adapter abstraction remains `NotificationChannelAdapter`, keyed by channel name, because each adapter can hide provider-specific APIs, credentials, retries, and provider payload mapping.
- The outbox schema must stop constraining `channel` to only email and web. Durable storage should accept any contract-level channel name and let adapter configuration decide whether dispatch can happen.
- Existing email and web integrations should remain source-compatible.

## Shipped Implementation

- `contracts/notifications` now has first-class channel payload contracts for email, SMS, RCS, web, and push.
- `contracts/notifications` now supports custom future channel names and custom channel payloads without requiring a contract release for every new integration.
- `NotificationChannelAdapter` now carries an optional `providerName`, and `createNotificationChannelAdapterRegistry` validates that only one adapter owns a channel in a composition root.
- `createNoopNotificationAdapter` works for any configured channel name and echoes the delivery channel in its receipt.
- `infrastructure/notification-outbox` now persists arbitrary notification channel names rather than constraining the database row to only email and web.
- `infrastructure/notification-outbox` dispatches through the shared adapter registry.
- SES and web notification adapters now declare their provider names and keep runtime channel validation at the adapter boundary.

Pressure-test notes:

- Normal flow: a source fact creates one notification message with multiple channel payloads; the outbox persists one delivery row per channel and the dispatcher calls the configured adapter for each.
- Missing adapter: delivery fails and retries through existing dispatcher behavior instead of losing the notification.
- Replay: stable idempotency keys and deterministic `deliveryId` values keep replay from duplicating sends.
- Future SMS/RCS/push provider: add a provider infrastructure package and compose its adapter; contracts and source-context message creation do not need new plumbing.
- Low-value card economics: Notifications can keep expensive SMS/RCS as preference and policy decisions, while email/web remain cheap defaults.

## Open Questions

None blocking. The current request names the required channel set and asks for extensibility; provider choice can remain adapter-specific.

## Implementation Checklist

- [x] Extend `contracts/notifications` with SMS, RCS, and push channel payload contracts.
- [x] Make provider receipts extensible while documenting known provider names.
- [x] Add adapter registry helper that future integrations can reuse.
- [x] Update notification contract tests to prove email, SMS, RCS, web, and push can coexist in one message.
- [x] Relax the notification outbox SQL channel constraint.
- [x] Add notification outbox tests proving new channels persist and dispatch through adapters.
- [x] Keep existing SES and web notification adapters compatible with the expanded contract.
- [x] Run targeted contract and infrastructure tests.

## Verification

- `pnpm --filter @chase-sets/notifications run test`
- `pnpm --filter @chase-sets/notification-outbox run test`
- `pnpm --filter @chase-sets/ses-email run test`
- `pnpm --filter @chase-sets/web-notifications run test`
- `pnpm --filter @chase-sets/notifications run typecheck`
- `pnpm --filter @chase-sets/notification-outbox run typecheck`
- `pnpm --filter @chase-sets/ses-email run typecheck`
- `pnpm --filter @chase-sets/web-notifications run typecheck`

## Documentation To Promote

- Keep this plan with the implementation PR.
- No ADR is required: the direction was already recommended in `docs/architecture/notifications-channel-and-provider-recommendation.md`, and this change makes the existing design operational.
- Promote additional provider-specific runbooks only when concrete SMS/RCS/push providers are added.

## Goal Completion Criteria

- Implementation is completed in this worktree and branch.
- The durable plan remains committed with the implementation.
- Contract and outbox tests cover the expanded channel abstraction.
- Targeted tests pass for `@chase-sets/notifications` and `@chase-sets/notification-outbox`.
- Typecheck is run for touched packages or a clear blocker is documented.
- The final summary names any verification gaps and the files changed.
- Later PR workflow should include PR submission, passing CI, merge, staging deploy verification, and retaining this plan for review.
