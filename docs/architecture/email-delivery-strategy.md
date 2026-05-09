# Email Delivery Strategy: Transactional + Marketing

## Why this exists

Chase Sets needs two different email capabilities with different reliability and cost profiles:

1. **Transactional email** for account and commerce-critical events (for example: magic-link sign-in, order confirmation, payout state changes).
2. **Marketing email** for campaigns and lifecycle messaging (for example: launch updates, seller tips, and win-back sequences).

Treating these as separate products keeps cost, deliverability, and operational risk clearer.

## Necessary vs optional email in the current platform

### Necessary transactional email (day-one scope)

The platform should treat the following as required to operate safely:

- Authentication and access:
  - Magic-link sign-in
  - Password reset (if password auth is enabled)
  - New device / security alerts
- Order and payment lifecycle:
  - Checkout/order confirmation
  - Payment success/failure updates
  - Refund confirmation
- Fulfillment and settlement lifecycle:
  - Shipment and delivery notifications
  - Payout initiated/completed/failed
  - Dispute or resolution state updates

These should be **event-driven** from bounded-context domain events and sent through a provider-agnostic contract.

### Marketing email (phase-two scope)

Marketing email is valuable but not operationally blocking. Start after transactional reliability is stable.

High-value early campaigns:

- Waitlist activation and onboarding drip
- Back-in-stock or saved-search alerts
- Seller education (listing quality, repricing nudges)
- Buyer reactivation campaigns

Marketing should be opt-in, preference-managed, and segmented from transactional sending infrastructure.

## Cost-first integration recommendation

### Recommendation

Adopt a **hybrid strategy**:

- **Transactional provider**: **Amazon SES** (lowest baseline send cost; strong at volume).
- **Marketing provider**: **Mailchimp** (or equivalent audience/campaign tool) only when marketing operations start.

This keeps day-one cost low and avoids paying for marketing platform overhead before it is needed.

### Why this is the best fit for Chase Sets right now

- Chase Sets is a high-volume marketplace with margin sensitivity, so unit send-cost matters.
- Transactional volume will likely grow with orders, payouts, and account activity.
- SES gives low per-message economics and scales without forcing an immediate all-in-one marketing subscription.
- Marketing needs (audiences, campaign builder, non-engineering workflows) can be added later without migrating transactional flows.

## Integration shape in this repository

Keep provider details in `infrastructure/` and keep behavior in bounded contexts.

### 1) Introduce a cross-context email contract

Create `contracts/communications-email` with:

- `sendTransactionalEmail(command)` for provider adapters
- `enqueueTransactionalEmail(command)` for event projectors
- provider-agnostic payload shape:
  - `messageType` (ubiquitous language, e.g. `auth.magic-link.requested`)
  - `to`, `subject`, `templateId`, `templateData`
  - idempotency key and correlation metadata

### 2) Add durable transactional outbox infrastructure

Add `infrastructure/transactional-email-outbox` implementing durable enqueue, claim, sent, retry, and failed states.

Responsibilities:

- idempotent event-projector writes keyed by message idempotency key
- worker-safe claiming with lease expiry
- provider failure retry scheduling
- terminal failed state after retries are exhausted

### 3) Add SES adapter in infrastructure

Add `infrastructure/ses-email` implementing the contract.

Responsibilities:

- SES API delivery
- provider error mapping
- provider-level retry behavior
- event logging hooks for observability

### 4) Emit email intents from owning bounded contexts

Each context emits explicit application events, for example:

- `auth`: `auth.magic-link.requested`
- `ordering` or `checkout`: `ordering.order.created`
- `settlement`: `settlement.payout.completed`

A context-owned projector maps those events to outbox entries. A deployable worker dispatches outbox entries through the provider gateway.

### 5) Add provider webhook ingestion

Use `infrastructure/provider-webhook-inbox` to normalize bounce/complaint/delivery events.

Project those events back into context-owned read models for:

- suppression status
- deliverability health
- notification audit trails

### 6) Add marketing only when needed

When campaigns start, add `infrastructure/mailchimp-marketing` (or chosen equivalent) with isolated contracts:

- audience sync
- campaign trigger
- unsubscribe/preference synchronization

Do not mix marketing campaign logic into transactional sending paths.

## Pressure test

### If we only choose one provider now

- **SES only** is acceptable and recommended for now.
- Delay marketing platform spend until there is a repeatable campaign calendar and owned KPIs.

### If marketing starts sooner than expected

- Keep transactional on SES.
- Add marketing provider as a second adapter rather than migrating existing transactional flows.

### If deliverability operations become heavy

- Add dedicated IPs and stricter sender reputation controls.
- Consider a premium transactional provider only when deliverability tooling ROI exceeds SES operational overhead.

## Decision summary

- **Now**: implement transactional email on SES through a new provider-agnostic contract.
- **Later**: add a dedicated marketing provider when campaign operations justify it.
- **Always**: keep transactional and marketing as separate bounded capabilities with separate contracts, adapters, and runbooks.
