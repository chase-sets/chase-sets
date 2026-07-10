# ADR 0005: Representative Staging Commerce State

## Status

Accepted

## Context

ADR 0003 separated production-safe bootstrap from fake scenario data so staging and production would not silently receive demo accounts, orders, payments, reviews, or support cases during deployment. That protected auditability, but it also made staging too empty to validate a production-like marketplace.

For Chase Sets, a production-like staging environment must include representative commerce density over the real Catalog integration output: products with and without market activity, listings, offers, purchases, sales, shipments, payments, settlement balances, payouts, reviews, support requests, and notification feed activity. Without those facts, staging cannot expose real product-page behavior, account workflows, low-value card economics, or cross-context projection issues.

The Catalog integrations are already the right source of product truth in staging. The missing piece is synthetic marketplace usage across current Catalog Items, especially items that were just imported or promoted and do not yet have listings, offers, or sales.

The risk is letting representative data become an implicit production deploy side effect or allowing it to run in production.

## Decision

Chase Sets introduces a fourth environment data profile: `representative-commerce-state`.

This profile is staging-focused representative commerce data. It is not normal deployment bootstrap and it is not production data. It is created only by an explicit operator workflow such as staging reset or a future staging refresh action.

Rules:

- Normal staging and production deployment bootstrap continue to run only `critical-bootstrap` and `catalog-integration-bootstrap`.
- `representative-commerce-state` is hard-blocked when `DEPLOYMENT_ENVIRONMENT=production`.
- Running representative state requires an explicit confirmation phrase.
- The profile keeps real Catalog integration data in place and normally selects eligible active Catalog Items from projected marketplace/catalog read models. A small, explicitly named acceptance fixture may be Catalog-owned when a cross-context staging behavior cannot be proved deterministically from provider data; the Product Contents container/contained pair is the first such fixture.
- Representative generation prioritizes current Catalog Items with no listings or offers, then adds accounts and commerce usage around them.
- Representative business usage must be created through bounded-context commands, APIs, and published facts, not direct read-model inserts.
- Bounded operator refreshes may use context-owned selected read-model reconciliation for already-published facts when a full live projection replay would make a post-import staging refresh unbounded. Marketplace, Inventory, and Discovery own their respective selected reconciliation helpers.
- Context-owned seed/support modules own their scenario behavior. Deployables only compose runtime entrypoints.
- Staging providers must use safe non-production rails such as Stripe test mode, EasyPost test mode, and internal test accounts.
- Production data, private payment details, payout destination details, raw provider payloads, and production PII must not be copied into representative state.
- Operator-facing scenario documentation and links belong in Platform Operations or runbooks, not in deployable-specific shortcuts.

## Consequences

- Staging can become production-like without making every deploy create or mutate representative commerce state.
- The old `scenario-seed` profile remains useful for dev, preview, and tests.
- Long-lived staging has one deterministic Product Contents acceptance fixture without enabling the broader fake `scenario-seed` dataset.
- Staging reset can rebuild a durable representative market after infrastructure recreation, and a manual refresh can add usage after new Catalog integration pulls.
- Production remains protected from representative state even if `PLATFORM_DATA_PROFILES` is misconfigured.
- Development seeds remain separate because many of them depend on fixed fake Catalog Item ids. Representative staging state must query current Catalog Items instead.
- Product-page completed sales history remains a separate Discovery read-model need; representative orders alone do not render sales history unless Discovery projects that presentation model.
