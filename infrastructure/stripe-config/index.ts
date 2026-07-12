import webhookEventRegistry from "./webhook-events.json";

export const STRIPE_API_VERSION = webhookEventRegistry.apiVersion;

export const STRIPE_PAYMENT_WEBHOOK_EVENTS = webhookEventRegistry.payment;

export const STRIPE_CONNECT_ACCOUNT_WEBHOOK_EVENTS = webhookEventRegistry.connectAccounts;

export const STRIPE_CONNECT_MONEY_MOVEMENT_WEBHOOK_EVENTS = webhookEventRegistry.connectMoneyMovement;

export function stripeWebhookEventsForConnectAccountsApi(accountsApi: "v1" | "v2") {
  return [
    ...STRIPE_PAYMENT_WEBHOOK_EVENTS,
    ...STRIPE_CONNECT_ACCOUNT_WEBHOOK_EVENTS[accountsApi],
    ...STRIPE_CONNECT_MONEY_MOVEMENT_WEBHOOK_EVENTS,
  ];
}
