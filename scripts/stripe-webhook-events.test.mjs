import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import { INTERNAL_ONLY_PAYMENT_EVENTS } from "./stripe-webhook-endpoint.mjs";
import { STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS, stripeV1ConnectWebhookEvents } from "./stripe-webhook-events.mjs";

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

    expect([...mappedEvents].sort()).toEqual(
      [...STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS, ...INTERNAL_ONLY_PAYMENT_EVENTS].sort(),
    );
    expect(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS).toEqual(webhookEventRegistry.payment);
  });

  it("never sends internal shared-payment facts in Stripe endpoint create requests", () => {
    expect(INTERNAL_ONLY_PAYMENT_EVENTS).toEqual([
      "shared_payment.granted_token.used",
      "shared_payment.granted_token.deactivated",
    ]);
    expect(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS).not.toContain("shared_payment.granted_token.used");
    expect(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS).not.toContain("shared_payment.granted_token.deactivated");
    expect(STRIPE_DELIVERABLE_PAYMENT_WEBHOOK_EVENTS.every((event) => !event.startsWith("shared_payment."))).toBe(true);
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

  it("derives the v1 webhook-endpoint Connect list from the registry without v2 names", () => {
    expect(stripeV1ConnectWebhookEvents("v2")).toEqual(webhookEventRegistry.connectMoneyMovement);
    expect(stripeV1ConnectWebhookEvents("v1")).toEqual([
      ...webhookEventRegistry.connectAccounts.v1,
      ...webhookEventRegistry.connectMoneyMovement,
    ]);
    expect(stripeV1ConnectWebhookEvents(" V1 ")).toEqual(stripeV1ConnectWebhookEvents("v1"));
    for (const posture of ["v1", "v2"]) {
      expect(stripeV1ConnectWebhookEvents(posture)).toEqual(expect.arrayContaining(["payout.paid", "payout.failed"]));
      expect(stripeV1ConnectWebhookEvents(posture).filter((event) => event.startsWith("v2."))).toEqual([]);
    }
    expect(() => stripeV1ConnectWebhookEvents("v3")).toThrow("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
    expect(() => stripeV1ConnectWebhookEvents("")).toThrow("STRIPE_CONNECT_ACCOUNTS_API must be one of: v1, v2.");
  });

  it("keeps the lifecycle Connect list on the registry derivation", () => {
    const lifecycleSource = source("scripts/provider-webhook-lifecycle.mjs");

    expect(lifecycleSource).toContain("stripeV1ConnectWebhookEvents(");
    expect(lifecycleSource).not.toContain("webhookEventRegistry.connect");
    expect(lifecycleSource).not.toMatch(/"(?:payout|account)\.[a-z_.]+"/u);
  });
});
