import { serve } from "@hono/node-server";
import {
  drainContextRuntime,
  refreshProjectionReplaySummary,
} from "@chase-sets/bounded-context-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import type { PaymentServices } from "@chase-sets/payments/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import { resolveActorFromRequest } from "./auth-request-context";
import { buildPlatformApiApp, createPlatformApiHost } from "./app";
import { loadConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";

const config = loadConfig();
const pools = createPlatformApiPools(config);

const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
        secretKey: config.paymentProcessor.secretKey,
        publishableKey: config.paymentProcessor.publishableKey,
        webhookSecret: config.paymentProcessor.webhookSecret,
        apiBaseUrl: config.paymentProcessor.apiBaseUrl,
        checkoutUiMode: config.paymentProcessor.checkoutUiMode,
      })
    : createFakePaymentProcessorGateway();
const moneyMovementGateway =
  config.moneyMovement.kind === "stripe"
    ? createStripeConnectMoneyMovementGateway({
        secretKey: config.moneyMovement.secretKey,
        webhookSecret: config.moneyMovement.webhookSecret,
        apiBaseUrl: config.moneyMovement.apiBaseUrl,
        onboardingReturnUrl: config.moneyMovement.onboardingReturnUrl,
        onboardingRefreshUrl: config.moneyMovement.onboardingRefreshUrl,
      })
    : createFakeMoneyMovementGateway();
const settlementOperationsRecorder = {
  record(event: Record<string, unknown>) {
    console.info(JSON.stringify({ type: "settlement.operation", ...event }));
  },
};

if (config.paymentProcessor.kind === "fake") {
  console.warn(
    "Platform API is using the fake payment processor because Stripe env vars are incomplete. Set STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET to enable Stripe locally.",
  );
}
if (config.moneyMovement.kind === "fake") {
  console.warn(
    "Platform API is using the fake money movement provider because Stripe Connect env vars are incomplete. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to enable Stripe Connect locally.",
  );
}
console.info(JSON.stringify({ type: "stripe.go-live-checks", ...config.stripeGoLive }));

const runtime = createPlatformApiHost({
  pools,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
  },
});
const app = buildPlatformApiApp(runtime, {
  drain: () => drainContextRuntime(runtime),
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  resolveActor: (request) =>
    resolveActorFromRequest(
      runtime.services.auth as Parameters<typeof resolveActorFromRequest>[0],
      request,
    ),
});

const PROJECTION_INTERVAL_MS = 1_000;
const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

startProjectorPolling(runtime.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});
startProjectorPolling(runtime.subscriptionRunners, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Subscription error:", error);
});

let reconciliationRunning = false;
let paymentReconciliationRunning = false;
let sellerFundsReleaseRunning = false;
if (config.paymentReconciliationIntervalMs) {
  setInterval(() => {
    if (paymentReconciliationRunning) {
      return;
    }
    paymentReconciliationRunning = true;
    const paymentServices = runtime.services.payments as PaymentServices;
    void paymentServices
      .scanPaymentsNeedingReconciliation({ limit: 100 })
      .then((result) => {
        console.info(JSON.stringify({
          type: "payments.reconciliation-needed",
          count: result.attention,
          paymentIds: result.payment_ids,
        }));
      })
      .catch((error: unknown) => {
        console.error("Payment reconciliation scan failed:", error);
      })
      .finally(() => {
        paymentReconciliationRunning = false;
      });
  }, config.paymentReconciliationIntervalMs);
}

if (config.sellerFundsReleaseIntervalMs) {
  setInterval(() => {
    if (sellerFundsReleaseRunning) {
      return;
    }
    sellerFundsReleaseRunning = true;
    const settlementServices = runtime.services.settlement as SettlementServices;
    void settlementServices.wallets
      .releaseMaturePendingSaleCredits({ limit: 500 }, SYSTEM_CONTEXT)
      .then((result: unknown) => {
        console.info(JSON.stringify({ type: "settlement.funds-release", result }));
      })
      .catch((error: unknown) => {
        console.error("Seller funds release failed:", error);
      })
      .finally(() => {
        sellerFundsReleaseRunning = false;
      });
  }, config.sellerFundsReleaseIntervalMs);
}

if (config.payoutReconciliationIntervalMs) {
  setInterval(() => {
    if (reconciliationRunning) {
      return;
    }
    reconciliationRunning = true;
    const settlementServices = runtime.services.settlement as SettlementServices;
    void settlementServices.payouts
      .reconcilePayoutsNeedingAttention({ limit: 100 }, SYSTEM_CONTEXT)
      .then((result: unknown) => {
        console.info(JSON.stringify({ type: "settlement.reconciliation", result }));
      })
      .catch((error: unknown) => {
        console.error("Payout reconciliation failed:", error);
      })
      .finally(() => {
        reconciliationRunning = false;
      });
  }, config.payoutReconciliationIntervalMs);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Platform API listening on port ${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closePlatformApiPools(pools).finally(() => process.exit(0));
  });
}
