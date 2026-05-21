import "./observability-prelude";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createNoopNotificationAdapter, type NotificationChannelAdapter } from "@chase-sets/notifications";
import {
  createNoopTransactionalEmailGateway,
  type TransactionalEmailGateway,
  type TransactionalEmailMessage,
  type TransactionalEmailTemplateRenderer,
} from "@chase-sets/communications-email";
import {
  createSesEmailNotificationAdapter,
  createSesSendRequest,
  createSesTransactionalEmailGateway,
} from "@chase-sets/ses-email";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels-testing";
import type { PaymentsServices } from "@chase-sets/payments/server";
import type { SettlementServices } from "@chase-sets/settlement/server";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  collectWorkerRunners,
  createWorkerHost,
  createWorkerRunnerLoop,
  type WorkerHostRuntime,
  type WorkerRunner,
} from "@chase-sets/platform-runtime/worker";
import {
  createPostgresTransactionalEmailOutbox,
  createTransactionalEmailOutboxDispatcher,
} from "@chase-sets/transactional-email-outbox";
import { createNotificationOutboxDispatcher, createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createPostgresWebNotificationAdapter } from "@chase-sets/web-notifications";
import { createTwilioMessagingAdapter } from "@chase-sets/twilio-messaging";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { loadConfig } from "./config";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const platformEmailTemplateRenderer: TransactionalEmailTemplateRenderer = {
  render(message) {
    const bodyLines = renderPlatformEmailBodyLines(message);
    const textBody = [message.subject, "", ...bodyLines].join("\n");
    const htmlBody = [
      "<!doctype html>",
      '<html lang="en">',
      "<body>",
      `<h1>${escapeHtml(message.subject)}</h1>`,
      ...bodyLines.map((line) =>
        line.trim().length === 0 ? "<br>" : `<p>${linkifyEscapedText(escapeHtml(line))}</p>`,
      ),
      "</body>",
      "</html>",
    ].join("");

    return {
      subject: message.subject,
      htmlBody,
      textBody,
    };
  },
};
const config = loadConfig();
const pools = createPlatformWorkerPools(config);
await bootstrapPlatformControlPlane(pools.control);
const controlPlane = createPostgresPlatformControlPlane(pools.control);

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
const commercialTermsResolver = pools["commercial-terms"]
  ? createCommercialTermsResolver({ db: pools["commercial-terms"] })
  : undefined;
const balanceCreditResolver = pools.settlement ? createSettlementBalanceCreditResolver(pools.settlement) : undefined;
const transactionalEmailGateway = createPlatformTransactionalEmailGateway(config.notificationEmail);
const emailNotificationAdapter = createPlatformEmailNotificationAdapter(config.notificationEmail);

const runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
  pools,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
    postageLabelProvider,
    ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
    ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
  },
});

const runners = [
  ...collectWorkerRunners(runtime),
  ...createCatalogBulkJobRunners(runtime.services, config),
  ...createNotificationDispatchRunners(runtime, config.workerId, emailNotificationAdapter),
  ...createTransactionalEmailDispatchRunners(runtime, config.workerId, transactionalEmailGateway),
  ...createScheduledJobRunners(runtime.services, config),
];
const runnerLoop = createWorkerRunnerLoop({
  workerId: config.workerId,
  controlPlane,
  runners,
  maxConcurrentRunners: config.maxConcurrentRunners,
  leaseTtlMs: config.leaseTtlMs,
  leaseRenewIntervalMs: config.leaseRenewIntervalMs,
  pollIntervalMs: config.pollIntervalMs,
  onError: (error, runner) => {
    logger.error("Platform worker runner failed.", {
      type: "platform-worker.runner.failed",
      runner: runner.name,
      runnerKind: runner.kind,
      error,
    });
  },
});

await controlPlane.heartbeatWorker({
  workerId: config.workerId,
  workerKind: "platform-worker",
  metadata: { runnerCount: runners.length },
});
const heartbeatTimer = setInterval(
  () => {
    void controlPlane
      .heartbeatWorker({
        workerId: config.workerId,
        workerKind: "platform-worker",
        metadata: { runnerCount: runners.length },
      })
      .catch((error) => {
        logger.error("Platform worker heartbeat failed.", {
          type: "platform-worker.heartbeat.failed",
          error,
        });
      });
  },
  Math.max(5_000, Math.floor(config.leaseTtlMs / 3)),
);
heartbeatTimer.unref?.();
runnerLoop.start();

const app = new Hono();
app.get("/health/live", (c) => c.json({ status: "ok" }));
app.get("/health/ready", async (c) => {
  await pools.control.query("SELECT 1");
  return c.json({ status: "ok" });
});
app.get("/internal/workers/status", async (c) =>
  c.json({
    status: "ok",
    loop: runnerLoop.status(),
    workers: await controlPlane.listWorkerHeartbeats(),
    runners: await controlPlane.listRunnerStatuses(),
    leases: await controlPlane.listLeases(),
  }),
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Platform worker listening.", {
    type: "platform-worker.started",
    port: info.port,
    workerId: config.workerId,
    runnerCount: runners.length,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(heartbeatTimer);
    void runnerLoop
      .stop()
      .finally(() => closePlatformWorkerPools(pools))
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}

function createScheduledJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<
    ReturnType<typeof loadConfig>,
    "paymentReconciliationIntervalMs" | "sellerFundsReleaseIntervalMs" | "payoutReconciliationIntervalMs"
  >,
): readonly WorkerRunner[] {
  const payments = services.payments as PaymentsServices | undefined;
  const settlement = services.settlement as SettlementServices | undefined;
  const runners: WorkerRunner[] = [];

  if (payments && input.paymentReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner("payments.reconciliation", input.paymentReconciliationIntervalMs, async () => {
        const result = await payments.payments.scanPaymentsNeedingReconciliation({
          limit: 100,
          claimOwnerId: config.workerId,
          claimTtlMs: config.leaseTtlMs * 4,
        });
        logger.info("Payment reconciliation scan completed.", {
          type: "payments.reconciliation-needed",
          count: result.attention,
        });
        return result.checked;
      }),
    );
  }

  if (settlement && input.sellerFundsReleaseIntervalMs) {
    runners.push(
      createScheduledJobRunner("settlement.seller-funds-release", input.sellerFundsReleaseIntervalMs, async () => {
        const result = await settlement.wallets.releaseMaturePendingSaleCredits(
          {
            limit: 500,
            claimOwnerId: config.workerId,
            claimTtlMs: config.leaseTtlMs * 4,
          },
          SYSTEM_CONTEXT,
        );
        logger.info("Seller funds release completed.", {
          type: "settlement.funds-release",
          result,
        });
        return typeof result === "object" && result && "released" in result
          ? Number((result as { released: unknown }).released)
          : 0;
      }),
    );
  }

  if (settlement && input.payoutReconciliationIntervalMs) {
    runners.push(
      createScheduledJobRunner("settlement.payout-reconciliation", input.payoutReconciliationIntervalMs, async () => {
        const result = await settlement.payouts.reconcilePayoutsNeedingAttention(
          {
            limit: 100,
            claimOwnerId: config.workerId,
            claimTtlMs: config.leaseTtlMs * 4,
          },
          SYSTEM_CONTEXT,
        );
        logger.info("Payout reconciliation completed.", {
          type: "settlement.reconciliation",
          result,
        });
        return typeof result === "object" && result && "checked" in result
          ? Number((result as { checked: unknown }).checked)
          : 0;
      }),
    );
  }

  return runners;
}

function createCatalogBulkJobRunners(
  services: Readonly<Record<string, unknown>>,
  input: Pick<ReturnType<typeof loadConfig>, "workerId" | "leaseTtlMs">,
): readonly WorkerRunner[] {
  const catalog = services.catalog as
    | {
        sourceObservations?: {
          processNextBulkReviewJob?: (input: { claimOwnerId: string; claimTtlMs: number }) => Promise<number>;
        };
      }
    | undefined;
  const processNextBulkReviewJob = catalog?.sourceObservations?.processNextBulkReviewJob;

  if (!processNextBulkReviewJob) {
    return [];
  }

  return [
    {
      name: "catalog.source-observation-bulk-jobs",
      kind: "job",
      runOnce: async () => ({
        processed: await processNextBulkReviewJob({
          claimOwnerId: input.workerId,
          claimTtlMs: input.leaseTtlMs * 4,
        }),
        lastGlobalPosition: "0" as never,
      }),
    },
  ];
}

function createTransactionalEmailDispatchRunners(
  runtime: WorkerHostRuntime,
  workerId: string,
  gateway: TransactionalEmailGateway,
): readonly WorkerRunner[] {
  const emailOutboxContextNames = new Set<string>(
    workerContextRegistry
      .filter((entry) =>
        entry.manifest.hostPorts?.some((port: { portName: string }) => port.portName === "transactionalEmailOutbox"),
      )
      .map((entry) => entry.contextName),
  );

  return runtime.mountedContexts
    .filter((context) => emailOutboxContextNames.has(context.contextName))
    .map((context) => {
      const dispatcher = createTransactionalEmailOutboxDispatcher({
        outbox: createPostgresTransactionalEmailOutbox({ db: context.pool }),
        gateway,
        claimOwnerId: `${workerId}:${context.contextName}:transactional-email`,
      });

      return {
        name: `${context.contextName}.transactional-email-dispatcher`,
        kind: "job",
        runOnce: dispatcher.runOnce,
      };
    });
}

function createNotificationDispatchRunners(
  runtime: WorkerHostRuntime,
  workerId: string,
  emailAdapter: NotificationChannelAdapter,
): readonly WorkerRunner[] {
  const notificationCenterContext = runtime.mountedContexts.find((context) => context.contextName === "notifications");
  const mobileMessageAdapters: readonly NotificationChannelAdapter[] =
    config.mobileMessaging.kind === "twilio"
      ? [
          createTwilioMessagingAdapter({
            accountSid: config.mobileMessaging.accountSid,
            authToken: config.mobileMessaging.authToken,
            messagingServiceSid: config.mobileMessaging.messagingServiceSid,
            channel: "sms",
            apiBaseUrl: config.mobileMessaging.apiBaseUrl,
            statusCallbackBaseUrl: config.mobileMessaging.statusCallbackBaseUrl,
          }),
          createTwilioMessagingAdapter({
            accountSid: config.mobileMessaging.accountSid,
            authToken: config.mobileMessaging.authToken,
            messagingServiceSid: config.mobileMessaging.messagingServiceSid,
            channel: "rcs",
            apiBaseUrl: config.mobileMessaging.apiBaseUrl,
            statusCallbackBaseUrl: config.mobileMessaging.statusCallbackBaseUrl,
          }),
        ]
      : [createNoopNotificationAdapter("sms"), createNoopNotificationAdapter("rcs")];
  const notificationOutboxContextNames = new Set<string>(
    workerContextRegistry
      .filter((entry) =>
        entry.manifest.hostPorts?.some((port: { portName: string }) => port.portName === "notificationOutbox"),
      )
      .map((entry) => entry.contextName),
  );

  return runtime.mountedContexts
    .filter((context) => notificationOutboxContextNames.has(context.contextName))
    .map((context) => {
      const webNotificationDb = notificationCenterContext?.pool ?? context.pool;
      const dispatcher = createNotificationOutboxDispatcher({
        outbox: createPostgresNotificationOutbox({ db: context.pool }),
        adapters: [
          emailAdapter,
          ...mobileMessageAdapters,
          createPostgresWebNotificationAdapter({ db: webNotificationDb }),
        ],
        claimOwnerId: `${workerId}:${context.contextName}:notifications`,
      });

      return {
        name: `${context.contextName}.notification-dispatcher`,
        kind: "job",
        runOnce: dispatcher.runOnce,
      };
    });
}

function createScheduledJobRunner(name: string, intervalMs: number, job: () => Promise<number>): WorkerRunner {
  let nextRunAt = 0;

  return {
    name,
    kind: "job",
    runOnce: async () => {
      if (Date.now() < nextRunAt) {
        return { processed: 0, lastGlobalPosition: "0" as never };
      }

      nextRunAt = Date.now() + intervalMs;
      const processed = await job();
      return { processed, lastGlobalPosition: "0" as never };
    },
  };
}

function createPlatformTransactionalEmailGateway(
  input: ReturnType<typeof loadConfig>["notificationEmail"],
): TransactionalEmailGateway {
  if (input.provider !== "amazon-ses") {
    return createNoopTransactionalEmailGateway();
  }

  const ses = requireCompleteSesConfig(input.ses);

  return createSesTransactionalEmailGateway({
    fromEmail: ses.fromEmail,
    configurationSetName: ses.configurationSetName,
    sourceArn: ses.sourceArn,
    templateRenderer: platformEmailTemplateRenderer,
    sendRequest: createSesSendRequest({ region: ses.region }),
    onAttempt: (event) => {
      logger.info("Transactional email send attempted.", {
        type: "transactional-email.send.attempt",
        provider: "amazon-ses",
        messageType: event.messageType,
        attempt: event.attempt,
        correlationId: event.correlationId,
      });
    },
    onResult: (event) => {
      const payload = {
        type: "transactional-email.send.result",
        provider: "amazon-ses",
        messageType: event.messageType,
        success: event.success,
        ...(event.error ? { error: event.error } : {}),
      };
      if (event.success) {
        logger.info("Transactional email send accepted.", payload);
      } else {
        logger.warn("Transactional email send failed.", payload);
      }
    },
  });
}

function createPlatformEmailNotificationAdapter(
  input: ReturnType<typeof loadConfig>["notificationEmail"],
): NotificationChannelAdapter {
  if (input.provider !== "amazon-ses") {
    return createNoopNotificationAdapter("email");
  }

  const ses = requireCompleteSesConfig(input.ses);

  return createSesEmailNotificationAdapter({
    fromEmail: ses.fromEmail,
    configurationSetName: ses.configurationSetName,
    sourceArn: ses.sourceArn,
    templateRenderer: platformEmailTemplateRenderer,
    sendRequest: createSesSendRequest({ region: ses.region }),
  });
}

function requireCompleteSesConfig(ses: ReturnType<typeof loadConfig>["notificationEmail"]["ses"]) {
  const { region, fromEmail, configurationSetName, sourceArn } = ses;
  if (!region || !fromEmail || !configurationSetName || !sourceArn) {
    throw new Error("Complete SES configuration is required when Amazon SES email is enabled.");
  }

  return { region, fromEmail, configurationSetName, sourceArn };
}

function renderPlatformEmailBodyLines(message: TransactionalEmailMessage): readonly string[] {
  if (message.templateId === "auth_magic_link") {
    return [
      "Use this secure link to sign in to Chase Sets:",
      String(message.templateData.magicLink ?? ""),
      "",
      "This link expires soon. If you did not request this email, you can ignore it.",
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "order_confirmed") {
    return [
      "Your Chase Sets order has been confirmed.",
      `Order ID: ${String(message.templateData.orderId ?? "")}`,
      `Order total: ${String(message.templateData.orderTotal ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  if (message.templateId === "shipment_delivered") {
    return [
      "Your Chase Sets shipment has been delivered.",
      `Order ID: ${String(message.templateData.orderId ?? "")}`,
      `Tracking number: ${String(message.templateData.trackingNumber ?? "")}`,
      "",
      "Chase Sets",
    ];
  }

  const dataLines = Object.entries(message.templateData).map(([key, value]) => `${key}: ${String(value ?? "")}`);
  return ["A Chase Sets account update is available.", ...dataLines, "", "Chase Sets"];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function linkifyEscapedText(value: string) {
  return value.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener noreferrer">$1</a>');
}

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};
