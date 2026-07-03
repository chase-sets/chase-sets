# Source-Context Wake Registry

## Purpose

The source-context wake registry is the rollout source of truth for push-driven projection wake enablement. It answers two questions from one platform-owned contract:

- Which bounded contexts may emit event-store wake notifications after committing events.
- Which source contexts the worker-owned relay may fan out into durable projection wake intents.

The registry lives in `@chase-sets/platform-runtime/source-context-wake-registry`. Runtime code derives write-side emission and relay fan-out behavior from it.

## Current Runtime State

The full wave-1 hot path — `checkout`, `marketplace`, `ordering`, `payments` — is `staging-enabled` with both runtime halves on (`checkout` since 2026-06-10; the wave-1 remainder since 2026-06-11 on the back of checkout's staging push-loop evidence in the [SLO/load proof](./push-wake-slo-load-proof.md)). `inventory` is also direct-listened as part of the checkout hot path because Inventory reservation outcomes advance Ordering purchases to payment readiness. `identity` is direct-listened in wave 2 for User presentation preference convergence and Identity account/security exact reads. `catalog` remains `staging-enabled` in wave 2 for Source Observation import/review freshness, Catalog Product Contents read-model freshness, and Catalog-sourced consumer projections. `settlement` is `staging-enabled` in wave 3 for payout-readiness projection freshness used by seller checkout readiness, and `public-presence` is `staging-enabled` for public waitlist write-to-admin-review freshness. Terraform provisions direct `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` values for `checkout`, `identity`, `inventory`, `marketplace`, `ordering`, and `payments`; `catalog`, `public-presence`, and `settlement` relay fan-out still rely on catch-up passes when no direct listener URL is present, so those contexts are staging acceleration evidence, not direct LISTEN latency proof for production. Other entries remain non-emitting and non-listening:

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
The tier decision is now explicit: on the current `db-s-2vcpu-4gb` production tier, the rolling-deploy overlap budget is 70/94 and the 80% tier-upgrade trigger is 75. The remaining wave-2 listener expansion needs two more direct contexts (`catalog`, `fulfillment`) and fits at 74/94, below the trigger, but adding a 3rd `platform-api` instance or a 2nd `platform-worker` instance crosses the trigger and requires `db-s-4vcpu-8gb` or production transaction pools first (#3342). Run `pnpm run ops push-wake:capacity-evidence -- --out artifacts/release-health/push-wake-capacity-evidence.json` for the checked-in no-secret evidence record.

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
| `wave-2-commerce-dependencies` | `catalog`, `fulfillment`, `identity`, `inventory` | Add high-fanout commerce dependencies after capacity and topology proof; `catalog` is staging-enabled for import/review, Product Contents, and downstream consumer projection freshness, `identity` is staging-enabled for user presentation preference and account/security freshness, and `inventory` is staging-enabled for reservation outcome and supply freshness. |
| `wave-3-platform-expansion` | `discovery`, `platform-operations`, `public-presence`, `settlement` | Expand lower-criticality or narrower fan-out contexts with owner approval; `settlement` is staging-enabled for seller payout-readiness freshness, `platform-operations` is staging-enabled for admin platform-feedback lifecycle freshness, and `public-presence` is staging-enabled for waitlist signup-to-admin-review freshness. |
| `wave-4-deferred-or-not-eligible` | `auth`, `commercial-terms`, `notifications`, `pricing` | Keep deferred or not-yet-eligible source contexts explicitly classified while their relay fan-out remains disabled. |

Wave membership is a rollout control, not a scheduling hint. Runtime code must consume the enablement flags, and operator tooling must show the rollout state.

## Production Gates

Production proof or production enabled states require evidence from:

- #1243 staging/production query-listener-control-plane topology parity.
- #1244 connection-budget model and Terraform safety checks.
- #1246 durable wake-store capacity proof.
- #1249 phase map and phase-gate evidence.

High-volume contexts should not be enabled until the wake-store capacity evidence and dashboard/runbook evidence are linked from the owning issue. Catalog is a high-fanout staging exception because provider imports write Source Observation events that must become reviewable without waiting on fallback projection polling. Identity is a high-fanout staging exception for User presentation preferences and account/security exact reads that must converge across reloads and sessions. Inventory is a high-volume staging exception for reservation outcome and supply writes that unblock Ordering, Marketplace, Pricing, and self-owned Inventory freshness. Settlement is a low-volume staging exception for payout-readiness writes that directly gate seller checkout readiness. Public Presence is a low-volume staging exception for waitlist signup writes that must become visible to admin review and production smoke verification without relying on stale polling windows.

## Runtime Consumers

Write-side service factories should derive `wakeNotifications` by calling `createEventStoreWakeNotificationConfigForSourceContext`. The worker-owned relay should derive source-context fan-out by calling `listSourceContextWakeRelayConfigs`.

Those two helpers intentionally read the same entry. A context is not active unless event-store wake notifications and relay fan-out are enabled together, preventing a half-wired source context from creating either useless notifications or unexplained fan-out.

## Rollback

Rollback changes registry state or kill-switch config; it does not remove exact read-after-write waits, durable projection checkpoints, fallback polling, or recovery UI. Disabling push acceleration must leave durable correctness intact.
