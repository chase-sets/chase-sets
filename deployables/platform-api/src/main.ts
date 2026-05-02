import "./observability-prelude";
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
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels-testing";
import type { PaymentServices } from "@chase-sets/payments/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import {
  getObservabilityRuntime,
  observeProjectors,
  observeWorker,
} from "@chase-sets/observability";
import { resolveActorFromRequest } from "./auth-request-context";
import { buildPlatformApiApp, createPlatformApiHost } from "./app";
import { loadConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";

const observability = getObservabilityRuntime();
const logger = observability.logger;
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
    logger.info("Settlement operation recorded.", {
      type: "settlement.operation",
      ...event,
    });
  },
};
const postageLabelProvider =
  config.postage.kind === "easypost"
    ? createEasyPostPostageLabelProvider({
        apiKey: config.postage.apiKey,
        apiBaseUrl: config.postage.apiBaseUrl,
        mode: config.postage.mode,
      })
    : createSandboxPostageLabelProvider();

if (config.paymentProcessor.kind === "fake") {
  logger.warn("Platform API is using the fake payment processor.", {
    type: "provider.fake",
    provider: "stripe-payments",
  });
}
if (config.moneyMovement.kind === "fake") {
  logger.warn("Platform API is using the fake money movement provider.", {
    type: "provider.fake",
    provider: "stripe-connect",
  });
}
if (config.postage.kind === "sandbox") {
  logger.warn("Platform API is using the sandbox USPS postage provider.", {
    type: "provider.sandbox",
    provider: "easypost",
  });
}
logger.info("Stripe go-live checks resolved.", {
  type: "stripe.go-live-checks",
  ...config.stripeGoLive,
});

const runtime = createPlatformApiHost({
  pools,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
    postageLabelProvider,
  },
});
const app = buildPlatformApiApp(runtime, {
  drain: () =>
    observeWorker(
      "context_runtime_drain",
      { worker: "context_runtime_drain" },
      () => drainContextRuntime(runtime),
    ),
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  readinessChecks: runtime.mountedContexts.map((entry) => ({
    name: `${entry.contextName}.database`,
    check: async () => {
      await entry.pool.query("SELECT 1");
    },
  })),
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

startProjectorPolling(
  observeProjectors(runtime.projectors, { worker: "projector" }),
  PROJECTION_INTERVAL_MS,
  (error) => {
    logger.error("Projection error.", {
      type: "projection.error",
      error,
    });
  },
);
startProjectorPolling(
  observeProjectors(runtime.subscriptionRunners, { worker: "subscription" }),
  PROJECTION_INTERVAL_MS,
  (error) => {
    logger.error("Subscription error.", {
      type: "subscription.error",
      error,
    });
  },
);

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
        logger.info("Payment reconciliation scan completed.", {
          type: "payments.reconciliation-needed",
          count: result.attention,
        });
      })
      .catch((error: unknown) => {
        logger.error("Payment reconciliation scan failed.", {
          type: "payments.reconciliation.failed",
          error,
        });
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
        logger.info("Seller funds release completed.", {
          type: "settlement.funds-release",
          result,
        });
      })
      .catch((error: unknown) => {
        logger.error("Seller funds release failed.", {
          type: "settlement.funds-release.failed",
          error,
        });
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
        logger.info("Payout reconciliation completed.", {
          type: "settlement.reconciliation",
          result,
        });
      })
      .catch((error: unknown) => {
        logger.error("Payout reconciliation failed.", {
          type: "settlement.reconciliation.failed",
          error,
        });
      })
      .finally(() => {
        reconciliationRunning = false;
      });
  }, config.payoutReconciliationIntervalMs);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Platform API listening.", {
    type: "platform-api.started",
    port: info.port,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closePlatformApiPools(pools)
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}
