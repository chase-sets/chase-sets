import "./observability-prelude";
import { serve } from "@hono/node-server";
import { createClient } from "redis";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider } from "@chase-sets/easypost-postage";
import { createSandboxPostageLabelProvider } from "@chase-sets/postage-labels-testing";
import {
  createMergedRealtimeWakeSignal,
  createPostgresRealtimeStreamLimiter,
  createPostgresRealtimeWakeSignal,
  createRealtimeOutboxPartitionMaintainer,
  createRealtimeRetentionSweeper,
  createRedisRealtimeStreamLimiter,
  type RealtimeObserver,
  type RealtimeStreamLimiter,
  type RealtimeWakeSignal,
} from "@chase-sets/platform-runtime/realtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import {
  getObservabilityRuntime,
  recordRealtimeAuthorizationRejected,
  recordRealtimeBatchRead,
  recordRealtimeConnectionClosed,
  recordRealtimeConnectionOpened,
  recordRealtimeMessageSent,
  recordRealtimeReadHub,
  recordRealtimeSyncRequired,
  recordRealtimeWakeNotificationReceived,
  recordRealtimeWakeWaitEnded,
} from "@chase-sets/observability";
import { resolveActorFromRequest } from "./auth-request-context";
import { buildPlatformApiApp, createPlatformApiHost } from "./app";
import { loadConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createPlatformApiPools(config);
await bootstrapPlatformControlPlane(pools.control);

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
const realtimeStores = runtime.mountedContexts
  .filter((entry) =>
    entry.contextName === "discovery" || entry.contextName === "marketplace"
  )
  .map((entry) => ({
    contextName: entry.contextName,
    db: entry.pool,
  }));
let realtimeActiveConnectionCount = 0;
const realtimeObserver = {
  connectionOpened: (event) => {
    realtimeActiveConnectionCount = event.activeConnectionCount;
    recordRealtimeConnectionOpened(event);
    logger.info("Realtime SSE connection opened.", {
      type: "realtime.connection.opened",
      activeConnectionCount: event.activeConnectionCount,
      topicCount: event.topics.length,
      storeNames: event.storeNames,
      actorAccountId: event.actorAccountId,
    });
  },
  connectionClosed: (event) => {
    realtimeActiveConnectionCount = event.activeConnectionCount;
    recordRealtimeConnectionClosed(event);
    logger.info("Realtime SSE connection closed.", {
      type: "realtime.connection.closed",
      activeConnectionCount: event.activeConnectionCount,
      durationMs: Math.round(event.durationMs),
    });
  },
  authorizationRejected: (event) => {
    recordRealtimeAuthorizationRejected(event);
    logger.warn("Realtime SSE subscription rejected.", {
      type: "realtime.authorization.rejected",
      reason: event.reason,
      topicCount: event.topics.length,
      actorAccountId: event.actorAccountId,
    });
  },
  topicNormalizationAdjusted: (event) => {
    logger.info("Realtime SSE topics normalized.", {
      type: "realtime.topic.normalized",
      requestedCount: event.diagnostic.requestedCount,
      normalizedCount: event.diagnostic.normalizedCount,
      duplicateCount: event.diagnostic.duplicateCount,
      blankCount: event.diagnostic.blankCount,
      invalidCount: event.diagnostic.invalidCount,
      sorted: event.diagnostic.sorted,
      actorAccountId: event.actorAccountId,
    });
  },
  batchRead: (event) => {
    recordRealtimeBatchRead(event);
    if (event.messageCount === 0 && event.expiredContextCount === 0) {
      return;
    }

    logger.info("Realtime SSE batch read.", {
      type: "realtime.batch",
      topicCount: event.topics.length,
      storeNames: event.storeNames,
      messageCount: event.messageCount,
      expiredContextCount: event.expiredContextCount,
      maxTopicLag: Math.max(0, ...event.topicLags.map((lag) => lag.lag)),
    });
  },
  readStarted: (event) => {
    recordRealtimeReadHub({ action: "started", topics: event.topics });
  },
  readCoalesced: (event) => {
    recordRealtimeReadHub({ action: "coalesced", topics: event.topics });
  },
  messageSent: (event) => {
    recordRealtimeMessageSent(event);
  },
  syncRequired: (event) => {
    recordRealtimeSyncRequired(event);
    logger.warn("Realtime SSE sync required.", {
      type: "realtime.sync.required",
      reason: event.reason,
      contexts: event.contexts,
      topicCount: event.topicCount,
      payloadBytes: event.payloadBytes,
    });
  },
  wakeWaitEnded: (event) => {
    recordRealtimeWakeWaitEnded(event);
  },
  wakeNotificationReceived: (event) => {
    recordRealtimeWakeNotificationReceived(event);
    if (event.matchedWaiterCount > 0) {
      return;
    }

    logger.debug("Realtime wake notification had no local matching waiters.", {
      type: "realtime.wake_notification.unmatched",
      waiterCount: event.waiterCount,
      notificationTopicCount: event.notificationTopics.length,
    });
  },
  retentionPruned: (event) => {
    if (event.deletedCount === 0) {
      return;
    }

    logger.info("Realtime retention pruned.", {
      type: "realtime.retention.pruned",
      contextName: event.contextName,
      deletedCount: event.deletedCount,
    });
  },
  streamError: (event) => {
    logger.error("Realtime SSE stream failed.", {
      type: "realtime.stream.error",
      connectionKey: event.connectionKey,
      error: event.error,
    });
  },
} satisfies RealtimeObserver;
const realtimeWakeSignal = await createPlatformRealtimeWakeSignal(
  [...new Set(realtimeStores.map((store) => store.db))],
  realtimeObserver,
);
const realtimeStreamLimiter = await createPlatformRealtimeStreamLimiter();
const app = buildPlatformApiApp(runtime, {
  internalAuthSecret: config.internalAuthSecret,
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  readinessChecks: [
    {
      name: "control.database",
      check: async () => {
        await pools.control.query("SELECT 1");
      },
    },
  ],
  resolveActor: (request) =>
    resolveActorFromRequest(
      runtime.services.auth as Parameters<typeof resolveActorFromRequest>[0],
      request,
    ),
  realtimeObserver,
  realtimeWakeSignal,
  realtimeStreamLimiter: realtimeStreamLimiter.limiter,
  realtimeActiveConnectionCount: () => realtimeActiveConnectionCount,
  realtimeRouteTuning: {
    batchSize: config.realtime.batchSize,
    pollIntervalMs: config.realtime.pollIntervalMs,
    heartbeatIntervalMs: config.realtime.heartbeatIntervalMs,
    retentionPruneIntervalMs: config.realtime.retentionPruneIntervalMs,
    maxConsecutiveFullBatches: config.realtime.maxConsecutiveFullBatches,
  },
  realtimeCursorSigningKeys: config.realtime.cursorSigningSecret
    ? {
        current: config.realtime.cursorSigningSecret,
        previous: config.realtime.previousCursorSigningSecrets,
      }
    : undefined,
  realtimeResourceLimits: {
    maxTopicsPerStream: config.realtime.maxTopicsPerStream,
    maxActiveStreams: config.realtime.maxActiveStreams,
    maxActiveStreamsPerConnectionKey: config.realtime.maxActiveStreamsPerConnectionKey,
  },
});
const realtimeRetentionSweeper = createRealtimeRetentionSweeper({
  stores: realtimeStores,
  intervalMs: config.realtime.retentionPruneIntervalMs,
  observer: realtimeObserver,
  onError: (error) => {
    logger.error("Realtime retention sweep failed.", {
      type: "realtime.retention.failed",
      error,
    });
  },
});
void realtimeRetentionSweeper.sweep();
const realtimePartitionMaintainerStores = [...new Set(
  realtimeStores.map((store) => store.db),
)].map((db) => {
  const contextNames = realtimeStores
    .filter((store) => store.db === db)
    .map((store) => store.contextName);
  return { db, contextNames };
});
const realtimePartitionMaintainers = realtimePartitionMaintainerStores.map((store) =>
  createRealtimeOutboxPartitionMaintainer({
    db: store.db,
    onError: (error) => {
      logger.error("Realtime outbox partition maintenance failed.", {
        type: "realtime.partition_maintenance.failed",
        contextNames: store.contextNames,
        error,
      });
    },
  }),
);
for (const maintainer of realtimePartitionMaintainers) {
  void maintainer.maintain();
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Platform API listening.", {
    type: "platform-api.started",
    port: info.port,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    realtimeRetentionSweeper.stop();
    for (const maintainer of realtimePartitionMaintainers) {
      maintainer.stop();
    }
    void Promise.resolve(realtimeWakeSignal?.stop?.())
      .finally(() => realtimeStreamLimiter.stop?.())
      .finally(() => closePlatformApiPools(pools))
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}

async function createPlatformRealtimeStreamLimiter(): Promise<Readonly<{
  limiter?: RealtimeStreamLimiter;
  stop?: () => Promise<void>;
}>> {
  if (config.realtime.streamLimiter.kind === "postgres") {
    return {
      limiter: createPostgresRealtimeStreamLimiter({
        pool: pools.control,
        leaseTtlMs: config.realtime.streamLimiter.leaseTtlMs,
        renewIntervalMs: config.realtime.streamLimiter.renewIntervalMs,
      }),
    };
  }

  if (config.realtime.streamLimiter.kind !== "redis") {
    return {};
  }

  const client = createClient({ url: config.realtime.streamLimiter.url });
  client.on("error", (error) => {
    logger.error("Realtime Redis stream limiter failed.", {
      type: "realtime.stream_limiter.redis.error",
      error,
    });
  });
  await client.connect();

  return {
    limiter: createRedisRealtimeStreamLimiter({
      client: {
        eval: async (script, options) => {
          const result = await client.eval(script, {
            keys: [...options.keys],
            arguments: [...options.arguments],
          });
          return typeof result === "number" || typeof result === "string"
            ? result
            : Number(result ?? 0);
        },
      },
      namespace: config.realtime.streamLimiter.namespace,
      leaseTtlSeconds: config.realtime.streamLimiter.leaseTtlSeconds,
    }),
    stop: async () => {
      await client.quit();
    },
  };
}

async function createPlatformRealtimeWakeSignal(
  pools: readonly { connect?: () => Promise<unknown> }[],
  observer: Pick<RealtimeObserver, "wakeNotificationReceived">,
): Promise<RealtimeWakeSignal | undefined> {
  const wakeSignals: RealtimeWakeSignal[] = [];

  for (const pool of pools) {
    if (typeof pool.connect !== "function") {
      continue;
    }

    let client: unknown;
    try {
      client = await pool.connect();
      wakeSignals.push(
        await createPostgresRealtimeWakeSignal(
          client as Parameters<typeof createPostgresRealtimeWakeSignal>[0],
          observer,
        ),
      );
    } catch (error) {
      (client as { release?: () => void } | undefined)?.release?.();
      logger.warn("Realtime Postgres wake signal unavailable for a context pool.", {
        type: "realtime.wake_signal.unavailable",
        error,
      });
    }
  }

  return createMergedRealtimeWakeSignal(wakeSignals);
}
