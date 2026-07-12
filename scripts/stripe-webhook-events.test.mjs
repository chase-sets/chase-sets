import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

function eventLiterals(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => match[1]);
}

describe("Stripe webhook event registry", () => {
  it("ratchets the shared payment registry against the payment adapter handler", () => {
    const paymentSource = source("infrastructure/stripe-payments/index.ts");
    const handlerSource = paymentSource.slice(
      paymentSource.indexOf("function mapWebhookEvent"),
      paymentSource.indexOf("export function createStripePaymentProcessorGateway"),
    );
    const mappedEvents = new Set([
      ...eventLiterals(handlerSource, /event\.type === "([^"]+)"/g),
      ...eventLiterals(handlerSource, /case "([^"]+)":/g),
    ]);

    expect([...mappedEvents].sort()).toEqual([...webhookEventRegistry.payment].sort());
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
