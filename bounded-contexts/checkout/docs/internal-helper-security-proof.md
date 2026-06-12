# Internal Helper Security Proof

Milestone #17 keeps customer checkout Shopify-simple. Internal proof modes, diagnostics, support lookup helpers,
provider test utilities, webhook replay, and deferred-payment helpers must stay outside customer checkout and fail closed
unless the owning operator surface grants the required permission.

This proof covers retained helper families that can influence launch checkout evidence. It does not approve new customer
surfaces. Customer-visible checkout may show only support-safe status and recovery copy.

## Requirements

- Customer routes must not expose proof, diagnostic, provider payload, webhook replay, or deferred-payment helper copy.
- Helper actions must require an authenticated non-customer actor and the owning permission before reading sensitive
  runtime state or starting any side effect.
- Allowed internal use must emit audit or observability with redacted fields only: no provider payloads, PII, card or bank
  details, cookies, session ids, raw emails, addresses, full URLs, proof references, or provider secrets.
- Checkout-owned retained helpers must appear in the fresh-state launch exception register with removal or conversion
  criteria.
- Provider callback replay and reconciliation stay owner-context behavior after confirmation; checkout must not expose a
  customer or generic support route that replays provider callbacks.

## Retained Helper Inventory

| Helper | Owner | Runtime surface | Gate | Customer reachable | Proof |
| --- | --- | --- | --- | --- | --- |
| `marketplace-production-proof-access` | Marketplace composition root | `deployables/marketplace/app/proof-access.server.ts` | `CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED=true` plus `security.manage` by default; public bypasses are limited to sign-in, guest-checkout exit, static assets, and health. | No | `deployables/marketplace/app/root.test.tsx` proves anonymous proof requests redirect to sign-in, sitemap is hidden, and signed-in actors without proof permission receive `403`; `deployables/marketplace/app/routes/ssr.test.tsx` proves resource routes stay hidden before proof auth. |
| `deferred-checkout-order-proof` | Checkout | `POST /checkout-sessions/:sessionId/confirm` with `deferPayment: true` | Non-guest actor, `security.manage`, and a non-placeholder production proof reference before order creation. | No | `bounded-contexts/checkout/features/sessions/api/route.test.ts` proves customer and placeholder requests are denied before session/order/payment side effects, allowed operator use records audit context, and observability redacts proof references, user ids, membership ids, session ids, and account ids. The retained helper is registered in `fresh-state-launch-exception-register.md`. |
| `admin-support-projection-diagnostics` | Platform Operations | Admin Support API projection and push-wake status routes | Authenticated platform actor with `security.manage`. | No | `deployables/admin-support-api/__tests__/app.test.ts` proves projection operations and push-wake status reject actors with only `catalog.view`, allow `security.manage`, and omit forwarded sensitive metadata such as `never-forwarded`. |
| `catalog-provider-diagnostics-and-test-utilities` | Catalog | Catalog admin/control-plane routes mounted through Admin Support API | `catalog.view` for redacted reads; `catalog.manage` for mutations, dry runs, reapply, replay, promotion, and provider-facing workload. | No | `deployables/admin-support-api/__tests__/app.test.ts` proves unauthenticated Catalog requests are rejected and Catalog mutations require `catalog.manage`; `bounded-contexts/catalog/docs/catalog-integration-admin-control-plane-rbac.md` pins the read/write permission matrix and redacted diagnostic scope. |
| `support-lookup-and-recovery-diagnostics` | Platform Operations with owning commerce context | Support operations page and API routes, using support-safe checkout/payment/order references | Authenticated support/admin actor with the support operation permission; checkout supplies support-safe references only. | No | `docs/runbooks/checkout-support-operations.md` requires support-safe references instead of raw URLs or session ids and forbids fake order/sale support requests before owner facts exist; checkout route and observability tests prove pending handoff states expose support-safe status without raw downstream identifiers. |
| `provider-webhook-replay-and-reconciliation` | Payments, Settlement, Fulfillment, and owning downstream contexts | Provider callback, background retry, and operator recovery paths after confirmation | Provider signature or owner-context operator recovery controls; no checkout customer route or generic replay endpoint. | No | `bounded-contexts/checkout/features/sessions/api/checkout-reconciliation-policy.test.ts` and `checkout-reversal-recovery-policy.test.ts` require signature-checked, metadata-correlated, redacted, idempotent replay/reconciliation with duplicate suppression and no duplicate owner effects. |

## Customer Route Guard

The fresh-state cleanup guard scans checkout customer UI/routes and English checkout localization for helper terminology.
It fails if customer-facing surfaces reintroduce proof-mode, diagnostics, provider-payload, webhook-replay, migration,
backfill, repair, selected-listing, stale-read-model, or manual-database-edit copy.

The deferred proof denial message is intentionally generic: "This checkout action is restricted." The error code remains
machine-readable for tests and internal telemetry, but the customer-visible message does not reveal proof, provider,
diagnostic, or operator details.

## Removal

`deferred-checkout-order-proof` is the only Checkout-owned retained helper in this inventory. Remove it during final
#1116 launch cleanup after production Stripe confirmation proof is complete, or convert it to an admin-support-only
operation with a dedicated runbook before launch. Other helper families remain in their owning contexts and are not
customer checkout capabilities.
