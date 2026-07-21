import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };

export const STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS = Object.freeze([...webhookEventRegistry.payment]);

export function appendStripeEnabledEvents(body, events) {
  for (const event of events) {
    body.append("enabled_events[]", event);
  }
}
