import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };

export const STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS = Object.freeze([...webhookEventRegistry.payment]);

// /v1/webhook_endpoints accepts only v1 event types; Stripe serves v2.* events through v2 event destinations.
// In v2 posture the Connect endpoint therefore subscribes to money movement only.
export function stripeV1ConnectWebhookEvents(connectAccountsApi) {
  const posture = String(connectAccountsApi ?? "").trim().toLowerCase();
  if (posture !== "v1" && posture !== "v2") {
    throw new Error("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
  }
  return Object.freeze([
    ...(posture === "v1" ? webhookEventRegistry.connectAccounts.v1 : []),
    ...webhookEventRegistry.connectMoneyMovement,
  ]);
}

export function appendStripeEnabledEvents(body, events) {
  for (const event of events) {
    body.append("enabled_events[]", event);
  }
}
