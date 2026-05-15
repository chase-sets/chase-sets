# Notifications (Transactional + Marketing) Channel and Provider Recommendation

## Decision summary

- **Primary recommendation:** use **Twilio for SMS/RCS** and **Amazon SES for email**.
- **Recommended stack for Chase Sets now:**
  - **SMS + RCS:** Twilio Programmable Messaging.
  - **Email (transactional + lifecycle/marketing):** Amazon SES.
- **Cost-control posture:**
  - Treat **email + in-app realtime** as the default channel.
  - Use **SMS/RCS as escalation channels** for high-value and time-sensitive moments only.
  - Start with **A2P 10DLC** sender type; add toll-free/short code only if throughput or deliverability pressure requires it.

## What changes when SES is the email provider

If SES is likely/mandated, the recommendation becomes a **split-channel provider strategy**:

1. **Twilio** remains the best first fit for SMS/RCS velocity and US compliance workflows.
2. **SES** becomes the system of record for email delivery and email cost optimization.

Practical impact:
- Lower email unit cost at moderate/high volumes.
- Better alignment if platform infra and IAM already center on AWS.
- More implementation ownership for email templates/sending discipline compared with an all-in-one marketing suite.

Net: this is a good change for cost discipline, and it does **not** weaken the Twilio-first SMS/RCS recommendation.

## Why this fits this architecture

This repository is event-sourced and event-driven, with bounded contexts as the canonical home of behavior. Notification delivery should therefore be modeled as:

1. **Domain events emitted by each bounded context** (orders, shipments, payouts, account security, etc.).
2. A dedicated **Notification bounded context** that subscribes to those events and decides:
   - message category (transactional vs marketing),
   - channel eligibility (email, in-app, SMS, RCS),
   - quiet hours/consent/rate limits,
   - provider selection and retries.
3. Provider adapters in infrastructure only.

This aligns with documented project principles: bounded-context ownership, thin deployables, and event-driven workflows. Existing runtime and outbox/realtime primitives in this repo already support this model.

## Channel necessity analysis

### 1) Transactional notifications (required)

Use cases likely required at launch:
- account security events,
- order/payment confirmations,
- shipment milestones and exceptions,
- payout status for sellers,
- critical operational alerts that affect money movement.

**Recommended channels by priority:**
1. In-app realtime/read-model updates (lowest marginal cost).
2. Email (cheap, durable audit trail, strong for receipts/confirmations).
3. SMS/RCS only for urgent, high-intent moments (delivery failure risk, fraud signal, shipment exception, payout issue requiring fast action).

### 2) Marketing notifications (optional but valuable)

Marketing sends can drive liquidity and conversion, but uncontrolled SMS marketing destroys margin on low-value GMV. Given product goals emphasize better margins for low-value cards, keep SMS marketing narrow and consent-driven.

**Recommended approach:**
- Start lifecycle marketing primarily in **email** (via SES).
- Use SMS/RCS marketing only for small, high-propensity cohorts with explicit opt-in and strict frequency caps.

### 3) Is RCS necessary now?

**Not necessary for MVP**, but useful as a progressive enhancement path.
- RCS can improve engagement with rich cards/buttons.
- Operationally, SMS remains universal fallback and compliance-heavy either way.

Recommendation: implement channel abstraction now, turn on RCS for selected campaigns/flows once baseline SMS + email reliability is proven.

## Provider evaluation (cost + operational fit)

## 1) Twilio for SMS/RCS (recommended)

Pros:
- Mature US messaging support, including A2P 10DLC requirements.
- Clear SMS + RCS product path in one API family.
- Good fit for event-driven integration with webhooks/status callbacks.

Cost considerations:
- US SMS base rates are published, but **carrier pass-through fees and A2P registration fees** add real cost.
- Failed-message processing fees can also apply.

Fit judgment:
- Best balance of implementation speed, ecosystem maturity, and operational predictability for US-first SMS/RCS rollout.

## 2) Amazon SES for email (recommended)

Pros:
- Typically lower email delivery cost at scale.
- Strong fit with AWS-native infrastructure, IAM, and observability.
- Reliable for transactional and lifecycle email when template and deliverability ops are handled well.

Considerations:
- Marketing campaign orchestration may require additional internal tooling/workflows.
- You still need disciplined suppression, preference, and template governance in your notification domain.

Fit judgment:
- Best email choice when cost and AWS alignment are priority constraints.

## 3) AWS End User Messaging for SMS (secondary)

Pros:
- Can be cost-competitive depending on route/country and existing AWS commitments.

Considerations:
- Operational complexity can exceed Twilio for teams optimizing early speed-to-market.

Fit judgment:
- Keep as a benchmark/phase-2 alternative after real traffic data exists.

## 4) Vonage (fallback benchmark)

Pros:
- Competitive global SMS positioning.

Considerations:
- For this stage, usually a benchmarking fallback unless route-level pricing materially wins.

Fit judgment:
- Not first integration.

## Recommended integration design (DDD + event-sourced)

Use the existing `bounded-contexts/notifications` context as the behavior owner.
The first SMS/RCS implementation uses provider-neutral `sms` and `rcs` channels
in the Notifications contract and dispatches them through the existing
`notification_outbox`; source contexts still publish facts only.

Vertical slices:
1. `notification-center`
2. `preferences`
3. Future `sms-rcs-delivery`
4. Future `delivery-health`

Core domain concepts:
- `NotificationIntent`
- `NotificationPolicy`
- `ChannelDecision`
- `DeliveryAttempt`
- `ConsentGrant`
- `SuppressionRule`

Implementation notes:
- Consume domain events through projector/subscriber pattern.
- Persist notification read models for support visibility and replay safety.
- Use idempotency keys for provider sends.
- Keep provider payloads/secrets in infrastructure boundary only.
- Use `infrastructure/twilio-messaging` for Twilio Programmable Messaging sends
  and signed status/inbound webhook normalization.
- Mount unauthenticated provider callbacks at
  `/api/notifications/provider/mobile-messaging/webhooks`; the route records
  normalized provider events in Notifications-owned storage.
- Emit delivery outcome events back into the event stream (sent, delivered, failed, suppressed, retried).

## Cost controls to keep margins healthy

1. **Channel ladder:** in-app → email (SES) → SMS/RCS escalation only.
2. **Per-event policy budget:** attach max channel cost per notification type.
3. **Frequency caps:** per account/day and per campaign window.
4. **Suppression windows:** do not send if user was active in app recently.
5. **Smart batching/digests:** collapse low-urgency events.
6. **Template governance:** short SMS copy to reduce segment count.
7. **Automated anomaly alerts:** sudden carrier fee or fail-rate spikes.
8. **Quarterly provider benchmark:** reprice SMS routes against AWS End User Messaging/Vonage and audit SES deliverability cost.

## Rollout plan

Phase 1 (now):
- Transactional email via SES + in-app realtime for core marketplace events.
- SMS only for account security + highest-severity order/shipment exceptions.

Phase 2:
- Add seller lifecycle and buyer re-engagement email campaigns (SES templates + policy-driven orchestration).
- Add limited SMS lifecycle nudges for explicit opt-in users.

Phase 3:
- Pilot RCS for select high-intent journeys (order issue resolution, premium restock alerts).
- Keep SMS fallback mandatory.

## Final recommendation

For Chase Sets’ current stage and cost discipline requirements:

- **Integrate Twilio Messaging for SMS/RCS + Amazon SES for email**.
- Build notifications as a **dedicated bounded context** with policy-driven channel routing.
- Keep **SMS/RCS constrained to high-value moments** until measured ROI justifies broader usage.
- Re-benchmark SMS providers after you have 60–90 days of real send and conversion data.
