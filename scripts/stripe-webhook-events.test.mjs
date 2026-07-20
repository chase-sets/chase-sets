import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import {
  INTERNAL_ONLY_PAYMENT_EVENTS,
  STRIPE_DELIVERED_EVENTS,
  STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS,
} from "./stripe-webhook-endpoint.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function eventLiterals(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => match[1]);
}

describe("Stripe webhook event registry", () => {
  it("partitions payment adapter events into Stripe-delivered and internal-only sets", () => {
    const paymentSource = source("infrastructure/stripe-payments/index.ts");
    const handlerSource = paymentSource.slice(
      paymentSource.indexOf("function mapWebhookEvent"),
      paymentSource.indexOf("export function createStripePaymentProcessorGateway"),
    );
    const mappedEvents = new Set([
      ...eventLiterals(handlerSource, /event\.type === "([^"]+)"/g),
      ...eventLiterals(handlerSource, /case "([^"]+)":/g),
    ]);

    expect([...mappedEvents].sort()).toEqual([...STRIPE_DELIVERED_EVENTS, ...INTERNAL_ONLY_PAYMENT_EVENTS].sort());
    expect(STRIPE_DELIVERED_EVENTS).toEqual(webhookEventRegistry.payment);
    expect(STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS).toEqual(STRIPE_DELIVERED_EVENTS);
  });

  it("never sends internal shared-payment facts in Stripe endpoint create requests", () => {
    expect(INTERNAL_ONLY_PAYMENT_EVENTS).toEqual([
      "shared_payment.granted_token.used",
      "shared_payment.granted_token.deactivated",
    ]);
    expect(STRIPE_DELIVERED_EVENTS).not.toContain("shared_payment.granted_token.used");
    expect(STRIPE_DELIVERED_EVENTS).not.toContain("shared_payment.granted_token.deactivated");
    expect(STRIPE_PAYMENTS_REQUIRED_WEBHOOK_EVENTS.every((event) => !event.startsWith("shared_payment."))).toBe(true);
  });

  it("ratchets the shared Connect registry against readiness and payout handlers", () => {
    const connectSource = source("infrastructure/stripe-connect/index.ts");
    const mappedEvents = new Set([
      ...eventLiterals(connectSource, /eventType === "([^"]+)"/g),
      ...eventLiterals(connectSource, /event\.type === "([^"]+)"/g),
    ]);
    const registeredEvents = [
      ...webhookEventRegistry.connectAccounts.v1,
      ...webhookEventRegistry.connectAccounts.v2,
      ...webhookEventRegistry.connectMoneyMovement,
    ];

    expect([...mappedEvents].sort()).toEqual([...registeredEvents].sort());
  });

  it("derives the CLI list from the selected Connect Accounts API posture", () => {
    const cliSource = source("scripts/stripe-cli.mjs");

    expect(cliSource).toContain("webhookEventRegistry.payment");
    expect(cliSource).toContain("webhookEventRegistry.connectAccounts[connectAccountsApi]");
    expect(cliSource).toContain("webhookEventRegistry.connectMoneyMovement");
  });
});
