# Staging Representative Commerce State

Representative commerce state makes staging useful for product and operational review without turning normal deployment bootstrap into demo-data creation.

## When To Run

Run representative state after staging has been reset or after Catalog integrations import/promote new items that need marketplace activity for product and workflow review.

Do not run it as part of production deployment. The platform API command rejects `DEPLOYMENT_ENVIRONMENT=production`.

## Command

The preferred staging operation is the `Platform Staging Representative Commerce State` GitHub Actions workflow. It is manually dispatched, requires the confirmation phrase, reads the live staging database connection pools from Terraform state, and runs the representative refresh command against the current staging Catalog projections. Use it after a staging reset or after a new Catalog integration import/promotion. Dispatch it with the release ref that is already deployed to staging, usually `main`.

The platform API package owns the runtime composition command:

```bash
REPRESENTATIVE_COMMERCE_STATE_CONFIRM="seed staging commerce" \
pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production
```

For local or non-standard non-production environments, set `REPRESENTATIVE_COMMERCE_STATE_ALLOW_LOCAL=true` with the same confirmation phrase.

## Expected Data

The representative profile keeps real Catalog integration output in place. It first finds active marketplace-projected Catalog Items with product measurement snapshots and no listings or offers, then layers representative usage over those current items.

The representative usage layer should reconcile:

- internal staging accounts that can buy, sell, or support workflows, including staging collector, value buyer, card vault, sealed stockroom, and support ops accounts;
- current provider-shaped Catalog Items and resolved Products selected from integration output;
- Inventory and storage locations;
- active, paused, draft, withdrawn, sold-out, and unavailable Listings;
- submitted and accepted Offers;
- Purchases and Sales across pending, cancelled, ready-for-fulfillment, and fulfilled states;
- Shipments across awaiting-package, awaiting-label, labeled, dispatched, delivered, returned, and exception states;
- Payments and Refunds across pending, captured, failed, cancelled, issued, and failed-refund states;
- Settlement wallets, holds, balances, payout requests, completed payouts, failed payouts, and reversals;
- Reviews, Support requests, and Notification feed items.

## Safety Rules

- Use bounded-context behavior, not direct read-model inserts.
- Use staging/test provider rails such as Stripe test mode and EasyPost test mode.
- Do not copy production PII, payment details, payout destination details, raw provider payloads, or production account data.
- Keep scenario ids stable and idempotent.
- Do not create fake Catalog Items in staging representative runs. Import/promote Catalog Items through Catalog integration workflows first.
- Prefer Catalog Items with no existing listings or offers so refreshes can add coverage after every integration pull.
- Skip Catalog Items without product measurement snapshots because accepted offers flow into Ordering and order creation requires product measurements.
- Document direct scenario links in Platform Operations or this runbook as they become available.

## Verification

After the command runs:

1. Confirm the command reports untouched Catalog Item candidates from `marketplace_catalog_items`.
2. Confirm marketplace search and at least one product detail page show listings and offers created from current Catalog Items.
3. Confirm at least one purchasing account has purchases, payments, shipments, reviews, notifications, and support requests.
4. Confirm at least one selling account has listings, offer matches, sales, shipments, wallet activity, payouts, reviews, and support requests.
5. Confirm projection lag is drained or explain the remaining lag.
6. Run staging smoke checks before promoting the release.
