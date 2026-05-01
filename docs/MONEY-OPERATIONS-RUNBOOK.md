# Money Operations Runbook

This runbook covers checkout, wallet, Stripe payments, Connect payouts, transfers, and provider webhooks. Settlement remains the wallet source of truth; Stripe owns payment method handling, hosted payout setup, external account collection, transfers, payouts, and provider risk controls.

## Ownership

- Product owns seller-facing copy, natural-language status labels, and support escalation paths.
- Support owns first-response triage using account payment, payout, wallet, and money health views.
- Operations owns reconciliation runs, platform balance monitoring, and Stripe Dashboard checks.
- Engineering owns adapter behavior, webhook signature verification, idempotency, schema rollout, and incident fixes.
- Finance owns Stripe balance funding decisions, payout release policies, refunds, disputes, and accounting reconciliation.

## Triage Order

1. Identify the account, payment, payout, order, and provider references involved.
2. Check the provider-neutral timeline before opening Stripe payload details.
3. Check idempotency records before retrying any payment, transfer, payout, refund, or dispute action.
4. Use reconciliation before manual correction when provider state is already available.
5. Use wallet operator actions only with a target seller account, idempotency key, and audit reason.

## Failed Payout

1. Open the payout timeline and confirm whether failure came from transfer submission, connected-account payout submission, or a provider webhook.
2. Confirm the payout has exactly one reversal ledger entry.
3. Run payout reconciliation if the provider payout reference exists and the local status is stale.
4. If Stripe reports an external account or requirement issue, ask the seller to continue payout setup through the hosted setup action.
5. Retry only after readiness shows transfer capability, payout capability, and payout destination are ready.

## Duplicate Webhook

1. Look up the provider event id.
2. Confirm the webhook event inbox table has only one processed row for that id.
3. Confirm no duplicate payout reversal or payment status transition was posted.
4. If a duplicate changed state, freeze payout retries for the affected account and escalate to engineering.

## Insufficient Platform Balance

1. Confirm the payout preview platform balance forecast.
2. Confirm the Stripe Dashboard available balance for the payout currency.
3. Do not debit the seller wallet if platform balance is already insufficient.
4. If a payout failed after debit, confirm the fail-fast reversal restored wallet available balance.
5. Finance decides whether to fund Stripe balance or ask the seller to retry later.

## Stuck Payout Setup

1. Refresh payout setup readiness.
2. If requirements remain missing, create a fresh hosted setup session.
3. If the setup URL expired, send the seller through the refresh URL flow so a new account link is generated after authentication.
4. Do not collect bank account, tax, identity, or other sensitive payout details in the app.

## Stuck Checkout

1. Check checkout status for blocking reason codes.
2. Check the payment timeline and provider event record.
3. Use deterministic checkout recovery for duplicate or interrupted submits.
4. Run payment reconciliation for stale provider status.
5. Keep card, bank, and wallet payment details inside Stripe-hosted or Stripe-managed confirmation surfaces.

## Refunds And Disputes

1. Confirm the provider event and provider object reference.
2. Confirm the wallet timeline shows the expected refund debit, dispute hold, dispute release, or reversal.
3. Use operator wallet actions only when provider reconciliation cannot express the required adjustment.
4. Finance owns the final accounting decision for partial refunds, lost disputes, and recovered disputes.

## Provider Outage

1. Check provider health endpoints and Stripe status.
2. Disable payout submissions before disabling webhook processing.
3. Keep accepting webhooks if signature verification is healthy.
4. Run reconciliation after recovery.
5. Do not switch production to fake adapters.

## Rollback

- Disable seller payout request actions first.
- Keep webhook endpoints online.
- Keep reconciliation available.
- Do not remove read-model columns during rollback.
- Do not replace Stripe adapters with fake adapters in production.
