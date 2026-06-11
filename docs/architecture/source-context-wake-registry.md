# Source-Context Wake Registry

## Purpose

The source-context wake registry is the rollout source of truth for push-driven projection wake enablement. It answers two questions from one platform-owned contract:

- Which bounded contexts may emit event-store wake notifications after committing events.
- Which source contexts the worker-owned relay may fan out into durable projection wake intents.

The registry lives in `@chase-sets/platform-runtime/source-context-wake-registry`. Runtime code derives write-side emission and relay fan-out behavior from it.

## Current Runtime State

The full wave-1 hot path — `checkout`, `marketplace`, `ordering`, `payments` — is `staging-enabled` with both runtime halves on (`checkout` since 2026-06-10; the wave-1 remainder since 2026-06-11 on the back of checkout's staging push-loop evidence in the [SLO/load proof](./push-wake-slo-load-proof.md)). Every other entry remains non-emitting and non-listening:

```ts
enablement: {
  eventStoreWakeNotifications: false,
  relayFanOut: false,
}
```

A context can only move into `staging-enabled`, `production-proof`, or `production-enabled` when both halves are enabled together. The per-projection-group consequences of the registry state are reported in the [push-first migration inventory](./push-first-projection-migration.md).

## Environment Gating

The registry is environment-global, so per-environment rollout is enforced by deployment kill switches, not registry state:

- `WORKER_PROJECTION_WAKE_RELAY_ENABLED` — staging `true`, production and previews `false`; only the staging relay opens listener connections and fans out.
- `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED` — staging `true`, production and previews `false`; forces every registry-derived emission config off so non-staging environments produce no unexplained notifications while their relay is off.

Production enablement flips these switches only after the production proof gates pass (#1243 topology parity, #1244 connection budgets, #1237 SLO/load proof).

## Registry Fields

Each entry records:

- Source context name and owner.
- Rollout state: `not-eligible`, `eligible`, `staging-enabled`, `production-proof`, `production-enabled`, `disabled`, or `opted-out`.
- Phase and rollout wave.
- Priority lane, expected event volume, and wake-store load estimate.
- Affected projection names sourced from `bounded-contexts/*/context.json`.
- Read-after-write route dependency IDs sourced from each context inventory.
- Required milestone issue gates.
- Production evidence issue gates.
- Runtime enablement flags for write-side event-store notifications and relay fan-out.

Tests compare the registry to bounded-context metadata so new contexts, projection groups, and read-after-write route inventory entries cannot silently miss rollout classification.

## Waves

| Wave | Contexts | Intent |
| --- | --- | --- |
| `wave-1-checkout-hot-path` | `checkout`, `marketplace`, `ordering`, `payments` | Protect guest Buy Now, payment handoff, submitted-offer, and order/payment hot paths first. |
| `wave-2-commerce-dependencies` | `catalog`, `fulfillment`, `identity`, `inventory` | Add high-fanout commerce dependencies after capacity and topology proof. |
| `wave-3-platform-expansion` | `discovery`, `public-presence`, `reputation`, `settlement`, `support` | Expand lower-criticality or narrower fan-out contexts with owner approval. |
| `wave-4-deferred-or-not-eligible` | `auth`, `commercial-terms`, `experience`, `insights`, `notifications`, `platform-operations`, `pricing`, `tax` | No current source projection fan-out or route dependency requiring event-store wake fan-out. |

Wave membership is a rollout control, not a scheduling hint. Runtime code must consume the enablement flags, and operator tooling must show the rollout state.

## Production Gates

Production proof or production enabled states require evidence from:

- #1243 staging/production query-listener-control-plane topology parity.
- #1244 connection-budget model and Terraform safety checks.
- #1246 durable wake-store capacity proof.
- #1249 phase map and phase-gate evidence.

High-volume contexts should not be enabled until the wake-store capacity evidence and dashboard/runbook evidence are linked from the owning issue.

## Runtime Consumers

Write-side service factories should derive `wakeNotifications` by calling `createEventStoreWakeNotificationConfigForSourceContext`. The worker-owned relay should derive source-context fan-out by calling `listSourceContextWakeRelayConfigs`.

Those two helpers intentionally read the same entry. A context is not active unless event-store wake notifications and relay fan-out are enabled together, preventing a half-wired source context from creating either useless notifications or unexplained fan-out.

## Rollback

Rollback changes registry state or kill-switch config; it does not remove exact read-after-write waits, durable projection checkpoints, fallback polling, or recovery UI. Disabling push acceleration must leave durable correctness intact.
