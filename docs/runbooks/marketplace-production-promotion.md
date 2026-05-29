# Marketplace Production Promotion

Production remains a landing and admin-support deployment until marketplace promotion is explicitly approved. Do not set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` until every gate below has an accountable owner and passing evidence.

## Required Gates

- Public Presence: prelaunch copy is replaced or reviewed for live marketplace availability, and terms, privacy, refunds and returns, order protection, and sales fee pages no longer describe live transactions as future-only.
- Payments: counsel/provider review approves buyer-facing Marketplace Checkout Fee copy, state-specific disclosures, refund language, and Stripe live-mode configuration.
- Settlement: Stripe Connect live-mode onboarding, manual payout schedule, payout readiness, payout holds, and platform-balance funding procedures are verified.
- Fulfillment: EasyPost production mode, label purchase, label refund/void, tracking, and exception workflows are verified.
- Support: account support can open structured buyer and seller order issues, operations can review overdue or urgent requests, and refund-producing resolutions are rehearsed against staging.
- Notifications: `NOTIFICATION_EMAIL_PROVIDER=amazon-ses` is enabled with complete production SES values, and magic link, order, payment, fulfillment, refund, support, and payout notices are verified.
- Staging: deployed staging critical flows and `pnpm run stripe:money-smoke -- --edge-check --seller-flow` pass for the same release commit.
- Production: the production workflow validates live Stripe keys, EasyPost production mode, production Connect URLs, SES configuration, marketplace domain readiness, and marketplace smoke before tagging the release.

## Promotion Switch

The production deploy uses `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED` from the production GitHub Environment. Keep it unset or `false` for the current launch posture.

When set to `true`, Terraform deploys the production marketplace surface, full platform API, platform worker, and commerce bounded-context databases. The same switch also requires live payment/shipping/email configuration before Terraform can plan.

## Rollback Posture

If promotion is enabled and production marketplace smoke fails, set `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` and redeploy the last known safe commit. That returns production to landing/admin-support while preserving staging as the full commerce verification environment.

