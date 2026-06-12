# ADR 0012: Unified Outbound Messaging

## Status

Accepted.

## Context

Outbound customer and operator messaging currently has two durable outbox implementations and two contract packages for the same event-driven delivery pattern:

- `contracts/notifications` defines multi-channel notification messages, delivery receipts, channel adapters, email/mobile webhooks, channel preferences, and a notification outbox port.
- `contracts/communications-email` defines transactional email messages, rendering, a transactional email gateway, and a second transactional email outbox port.
- `infrastructure/notification-outbox` stores one delivery row per notification channel with worker-safe claiming, retry scheduling, sent preservation, and per-channel delivery adapters.
- `infrastructure/transactional-email-outbox` stores one email row per idempotency key with the same worker-safe claiming, retry scheduling, sent preservation, and provider receipt behavior.
- `infrastructure/ses-email`, `infrastructure/local-email-capture`, `infrastructure/twilio-messaging`, and `infrastructure/web-notifications` are channel/provider adapters, but email adapters also expose the older transactional gateway shape.

Consumer evidence shows the split is accidental rather than domain-driven:

- `settlement` maps `settlement.payout.completed` facts to a single email message keyed by `settlement:payout_completed:<payoutId>`.
- `platform-operations` maps support request facts to single email messages after looking up the buyer email in its read model.
- `auth`, `fulfillment`, `ordering`, `payments`, and `public-presence` use the same transactional email outbox pattern for event-projector writes.
- `notifications`, `discovery`, and `auth` use the notification outbox pattern for event-projector writes that may fan out to web, email, SMS, RCS, or future channels.
- `platform-worker` composes both dispatchers and already has email providers available as notification channel adapters through SES and local capture.

The two outboxes preserve the same delivery semantics: source-event metadata, ordered claims by `next_attempt_at` then `outbox_id`, `FOR UPDATE SKIP LOCKED`, claim TTL recovery for stale `sending` rows, retry delay scheduling, max attempts, provider receipts, and no mutation of sent message payloads during idempotent replay. The difference is row identity: transactional email uses `idempotency_key`, while notification delivery uses `delivery_id`. A single-email notification preserves the transactional identity by using the message idempotency key as its delivery id; multi-channel notifications keep the existing `<idempotency_key>:<channel>:<index>` delivery ids.

## Decision

Use `contracts/notifications` as the outbound messaging contract for transactional customer communications and notification-center messages.

The target package shape is:

- `contracts/notifications` owns the shared outbound message contract: message intent, email/SMS/RCS/web/push channel payloads, delivery receipts, channel adapter registry, webhook gateway contracts, template rendering, and no-op test adapters.
- `contracts/communications-email` is retired. Transactional email is represented as a `NotificationMessage` with one `email` channel. The transactional email template renderer and provider gateway types move into `contracts/notifications` because SES and local capture still render and send email payloads.
- `infrastructure/notification-outbox` is the single durable outbox implementation. It stores one row per channel delivery, preserves the existing claim/retry/idempotency semantics, and dispatches through `NotificationChannelAdapter`.
- `infrastructure/transactional-email-outbox` is retired. Consumers enqueue `NotificationMessage` values through `NotificationOutbox`.
- `infrastructure/ses-email`, `infrastructure/local-email-capture`, `infrastructure/twilio-messaging`, and `infrastructure/web-notifications` remain provider/channel adapters behind `NotificationChannelAdapter`. SES and local capture may keep a low-level email gateway for direct adapter composition and tests, but application contexts should not depend on it.

The Notifications bounded context still owns notification-center policy, preferences, feed read models, and web notification settings. Source bounded contexts continue to own their business facts and may enqueue outbound messages for their own facts when no notification-center policy decision is required. The shared contract name remains `notifications` for now because it already carries the channel-neutral delivery vocabulary used by adapters; introducing a third `outbound-messaging` contract would add churn without improving the behavioral boundary.

## Alternatives Considered

### Keep `communications-email` as a separate email channel contract

Rejected. The current transactional email consumers do not need a separate delivery model; they need a single email channel delivery with the same source-event, retry, idempotency, and provider receipt semantics already present in `notification-outbox`. Keeping the package would preserve the package-graph smell and continue forcing deployables to compose two outbox dispatchers.

### Create new `contracts/outbound-messaging` and `infrastructure/outbound-message-outbox`

Deferred. `outbound messaging` is the accurate umbrella term, but the existing `notifications` contract already contains the general channel and webhook surfaces. A rename can be handled later if terminology becomes more important than migration cost. This phase optimizes for one implementation and fewer package homes.

### Route all transactional emails through the Notifications bounded context

Rejected. Notifications owns feed and delivery policy, not the source business facts. Some flows, such as settlement payout email and platform-operations support email, are direct operational communications from their owning contexts. They should share delivery infrastructure without forcing their behavior into the Notifications bounded context.

## Consequences

- There is one durable outbox table contract: `notification_outbox`. Existing database environments with `transactional_email_outbox` need an explicit migration or replay strategy before this is applied outside greenfield/dev databases.
- Single-email transactional messages become one `email` delivery row with the same delivery id as the message idempotency key. Replaying the same source fact remains idempotent.
- Worker composition becomes simpler: one outbox dispatcher, one adapter registry, and one retry policy.
- Provider SDKs remain outside `contracts/*`; contracts stay pure TypeScript types and helpers.
- Email delivery strategy documentation that references the retired email contract/outbox should treat this ADR as the superseding package-shape decision.

## Invariants

- Contracts must not import Hono, provider SDKs, database clients, or provider-specific infrastructure packages.
- Source-event metadata, ordering by `next_attempt_at` then `outbox_id`, retry behavior, max attempts, claim TTL recovery, and sent payload preservation must stay covered by outbox tests.
- Channel providers deliver only through `NotificationChannelAdapter` when used by application workers.
- Bounded contexts own their message intent mapping and tests; deployables only compose outbox stores, dispatchers, adapters, and renderers.
