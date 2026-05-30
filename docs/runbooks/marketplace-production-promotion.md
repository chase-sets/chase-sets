# Marketplace Production Promotion

Production remains a landing and admin-support deployment until marketplace promotion is explicitly approved. Do not set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` until every gate below has an accountable owner and passing evidence, and do not mark `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true` until the final launch review record exists.

## Required Gates

- Public Presence: prelaunch copy is replaced or reviewed for live marketplace availability, and terms, privacy, refunds and returns, order protection, and sales fee pages no longer describe live transactions as future-only.
- Tax: production Tax readiness evidence is approved, `PRODUCTION_TAX_READINESS_APPROVED=true`, `PRODUCTION_TAX_READINESS_REFERENCE` points to the approval record, and a provider-backed Tax Quote resolver is ready before live order creation.
- Payments: counsel/provider review approves buyer-facing Marketplace Checkout Fee copy, state-specific disclosures, refund language, and Stripe live-mode configuration.
- Settlement: Stripe Connect live-mode onboarding, manual payout schedule, payout readiness, payout holds, and platform-balance funding procedures are verified.
- Fulfillment: EasyPost production mode, label purchase, label refund/void, tracking, and exception workflows are verified.
- Support: account support can open structured buyer and seller order issues, operations can review overdue or urgent requests, and refund-producing resolutions are rehearsed against staging.
- Notifications: `NOTIFICATION_EMAIL_PROVIDER=amazon-ses` is enabled with complete production SES values, and magic link, order, payment, fulfillment, refund, support, and payout notices are verified.
- Staging: deployed staging critical flows and `pnpm run stripe:money-smoke -- --edge-check --seller-flow` pass for the same release commit.
- Production: the production workflow validates approved launch evidence, approved Tax readiness evidence, live Stripe keys, EasyPost production mode, production Connect URLs, SES configuration, marketplace domain readiness, and marketplace smoke before tagging the release.

## Promotion Switch

The production deploy uses `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED` from the production GitHub Environment. Keep it unset or `false` for the current launch posture.

When set to `true`, Terraform deploys the production marketplace surface, full platform API, platform worker, and commerce bounded-context databases. The same switch also requires approved marketplace promotion evidence, live payment/shipping/email configuration, and approved Tax readiness evidence before Terraform can plan.

Marketplace promotion evidence is carried by `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED` and `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE` in the production GitHub Environment. The reference must point to the final launch review record that confirms each required gate above has an accountable owner and passing evidence. `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` is only the deployment shape switch; it is not the launch approval by itself.

Tax readiness evidence is carried by `PRODUCTION_TAX_READINESS_APPROVED` and `PRODUCTION_TAX_READINESS_REFERENCE` in the production GitHub Environment. Keep approval unset until the Tax-owned launch posture has provider coverage and counsel/accounting review. Platform API also installs a production Tax blocker resolver until a provider-backed `TaxQuoteResolver` is composed, so a bypassed deployment still cannot create orders with implicit zero-tax snapshots.

## Rollback Posture

If promotion is enabled and production marketplace smoke fails, set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` and redeploy the last known safe commit. That returns production to landing/admin-support while preserving staging as the full commerce verification environment.
