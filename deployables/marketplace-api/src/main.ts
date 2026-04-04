import { serve } from "@hono/node-server";
import { resolveActorFromAuthApi } from "@chase-sets/auth-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  createFakePaymentProcessorGateway,
  createStripePaymentProcessorGateway,
} from "@chase-sets/payments";
import { loadConfig } from "./config";
import { buildMarketplaceApp } from "./app";
import { composeMarketplaceApiStack } from "./stack";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);

const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
        secretKey: config.paymentProcessor.secretKey,
        publishableKey: config.paymentProcessor.publishableKey,
        webhookSecret: config.paymentProcessor.webhookSecret,
        apiBaseUrl: config.paymentProcessor.apiBaseUrl,
      })
    : createFakePaymentProcessorGateway();

if (config.paymentProcessor.kind === "fake") {
  console.warn(
    "Marketplace API is using the fake payment processor because Stripe env vars are incomplete. Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET to enable Stripe locally.",
  );
}

const { services } = composeMarketplaceApiStack(pool, {
  processorGateway: paymentProcessorGateway,
});
const app = buildMarketplaceApp(
  services,
  {
    resolveActor: (request) =>
      resolveActorFromAuthApi({
        authApiBaseUrl: config.identityApiBaseUrl,
        request,
      }),
  },
);

const PROJECTION_INTERVAL_MS = 1_000;
const projectors = [
  ...services.discovery.projectors,
  ...services.inventory.projectors,
  ...services.marketplace.projectors,
  ...services.payments.projectors,
  ...services.fulfillment.projectors,
  ...services.ordering.projectors,
  ...services.reputation.projectors,
  ...services.settlement.projectors,
];

startProjectorPolling(
  projectors,
  PROJECTION_INTERVAL_MS,
  (error) => {
    console.error("Projection error:", error);
  },
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Marketplace API listening on port ${info.port}`);
});
