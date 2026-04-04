import { serve } from "@hono/node-server";
import { createDiscoveryServices } from "@chase-sets/discovery";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { createFulfillmentServices } from "@chase-sets/fulfillment";
import { resolveActorFromIdentityApi } from "@chase-sets/identity/server";
import { createInventoryServices } from "@chase-sets/inventory";
import {
  createMarketplaceServices,
  createMarketplaceSupplyResolver,
} from "@chase-sets/marketplace-context";
import { createOrderingServices } from "@chase-sets/ordering";
import {
  createPaymentsServices,
  createFakePaymentProcessorGateway,
  createStripePaymentProcessorGateway,
} from "@chase-sets/payments";
import { createReputationServices } from "@chase-sets/reputation";
import { createSettlementServices } from "@chase-sets/settlement";
import { loadConfig } from "./config";
import { buildMarketplaceApp } from "./app";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const discovery = createDiscoveryServices(pool);
const inventory = createInventoryServices(pool);
const marketplace = createMarketplaceServices(pool);
const ordering = createOrderingServices(pool, {
  supplyResolver: createMarketplaceSupplyResolver(marketplace),
  inventoryReservations: {
    createReservation: async ({ sellerAccountId, inventoryRecordId, quantity, reason, notes, context }) => {
      const result = await inventory.holds.createHold(
        {
          accountId: sellerAccountId,
          recordId: inventoryRecordId,
          quantity,
          reason,
          notes,
        },
        context as never,
      );

      return {
        holdId: result.holdId,
        inventoryRecordId,
        sellerAccountId,
        quantity,
      };
    },
    releaseReservation: async ({ sellerAccountId, holdId, context }) => {
      await inventory.holds.releaseHold(
        {
          accountId: sellerAccountId,
          holdId,
        },
        context as never,
      );
    },
  },
});
const fulfillment = createFulfillmentServices(pool);
const reputation = createReputationServices(pool);
const settlement = createSettlementServices(pool);

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

const payments = createPaymentsServices(pool, {
  processorGateway: paymentProcessorGateway,
  getOrderSnapshot: async (orderId, buyerAccountId) => {
    const order = await ordering.orders.getBuyerOrder(orderId, buyerAccountId);
    return order
      ? {
          orderId: order.order_id as never,
          buyerAccountId: order.buyer_account_id as never,
          totalAmount: order.total_amount,
          status: order.status,
        }
      : null;
  },
});
const app = buildMarketplaceApp(
  { discovery, fulfillment, inventory, marketplace, ordering, payments, reputation, settlement },
  {
    resolveActor: (request) =>
      resolveActorFromIdentityApi({
        identityApiBaseUrl: config.identityApiBaseUrl,
        request,
      }),
  },
);

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(
  [
    ...discovery.projectors,
    ...inventory.projectors,
    ...marketplace.projectors,
    ...payments.projectors,
    ...fulfillment.projectors,
    ...ordering.projectors,
    ...reputation.projectors,
    ...settlement.projectors,
  ],
  PROJECTION_INTERVAL_MS,
  (error) => {
    console.error("Projection error:", error);
  },
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Marketplace API listening on port ${info.port}`);
});
