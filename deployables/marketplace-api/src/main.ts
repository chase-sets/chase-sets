import { serve } from "@hono/node-server";
import { resolveActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  drainContextRuntime,
  refreshProjectionReplaySummary,
} from "@chase-sets/bounded-context-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";
import { buildMarketplaceApp } from "./app";
import { createContextRuntime } from "./context-runtime.generated";
import {
  createFakePaymentProcessorGateway,
  createStripePaymentProcessorGateway,
} from "./payment-processor";

const config = loadConfig();
const pools = {
  catalog: createPgPool(config.databaseUrls.catalog),
  discovery: createPgPool(config.databaseUrls.discovery),
  fulfillment: createPgPool(config.databaseUrls.fulfillment),
  identity: createPgPool(config.databaseUrls.identity),
  inventory: createPgPool(config.databaseUrls.inventory),
  marketplace: createPgPool(config.databaseUrls.marketplace),
  ordering: createPgPool(config.databaseUrls.ordering),
  payments: createPgPool(config.databaseUrls.payments),
  pricing: createPgPool(config.databaseUrls.pricing),
  reputation: createPgPool(config.databaseUrls.reputation),
  settlement: createPgPool(config.databaseUrls.settlement),
} as const;

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

const runtime = createContextRuntime(pools, {
  processorGateway: paymentProcessorGateway,
});
const { services } = runtime;
const app = buildMarketplaceApp(
  services,
  {
    drain: () => drainContextRuntime(runtime),
    getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
    resolveActor: (request) =>
      resolveActorFromAuthApi({
        authApiBaseUrl: config.identityApiBaseUrl,
        request,
      }),
  },
);

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(
  runtime.projectors,
  PROJECTION_INTERVAL_MS,
  (error) => {
    console.error("Projection error:", error);
  },
);
startProjectorPolling(
  runtime.subscriptionRunners,
  PROJECTION_INTERVAL_MS,
  (error) => {
    console.error("Subscription error:", error);
  },
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Marketplace API listening on port ${info.port}`);
});
