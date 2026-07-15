import "./observability-prelude";
import { serve } from "@hono/node-server";
import { createClient } from "redis";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationCatalogClient,
  createTcgplayerAutomationHttpClients,
} from "@chase-sets/catalog/server";
import { createFacebookSocialLoginProvider, createGoogleSocialLoginProvider } from "@chase-sets/auth/server";
import { createStripePaymentProcessorGateway } from "@chase-sets/stripe-payments";
import { createStripeConnectMoneyMovementGateway } from "@chase-sets/stripe-connect";
import { createEasyPostPostageLabelProvider, createEasyPostPostageWebhookGateway } from "@chase-sets/easypost-postage";
import {
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  readFilesystemObject,
  type ObjectStorage,
} from "@chase-sets/object-storage";
import { createSesEmailWebhookGateway } from "@chase-sets/ses-email";
import { createTwilioMessagingWebhookGateway } from "@chase-sets/twilio-messaging";
import {
  createInMemoryRealtimeStreamLimiter,
  createMergedRealtimeWakeSignal,
  createPostgresRealtimeStreamLimiter,
  createRealtimeOutboxPartitionMaintainer,
  createRealtimeOutboxWakeSignal,
  createRealtimeRetentionSweeper,
  createRedisRealtimeStreamLimiter,
  type RealtimeObserver,
  type RealtimeStreamLimiter,
  type RealtimeWakeSignal,
} from "@chase-sets/platform-runtime/realtime";
import {
  configureDefaultDurableJobStreamLimiter,
  createDurableJobStreamLimiterFromRealtime,
} from "@chase-sets/platform-runtime/durable-job-events";
import {
  createPostgresUcpIdempotencyStore,
  createUcpProfileKeyResolver,
  type UcpRuntimeObserver,
} from "@chase-sets/platform-runtime/ucp";
import type { McpAuditRecord } from "@chase-sets/platform-runtime/mcp";
import { createPostgresMcpAuditLog } from "@chase-sets/platform-runtime/mcp-audit-log";
import { createMcpToolCallLimiterFromRealtime } from "@chase-sets/platform-runtime/mcp-tool-call-limiter";
import {
  createAgentGrantRateLimiter,
  createPostgresAgentGrantConsentDirectory,
  createPostgresAgentGrantSpendPolicy,
} from "@chase-sets/platform-runtime/agent-guardrails";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import {
  createRuntimeLifecycleRegistry,
  runWithRuntimeLifecycleTimeout,
} from "@chase-sets/platform-runtime/runtime-lifecycle";
import {
  getObservabilityRuntime,
  recordCatalogControlPlaneEvent,
  recordCatalogIntegrationJob,
  recordCatalogIntegrationOptionQuery,
  recordDiscoverySearchQuerySignal,
  recordCheckoutObservabilityEvent,
  recordMcpAuditRecord,
  recordPublicPresenceWaitlistAnalytics,
  recordProjectionFreshnessWakeEnqueue,
  recordProviderWebhookIngestion,
  recordRealtimeAuthorizationRejected,
  recordRealtimeBatchRead,
  recordRealtimeConnectionClosed,
  recordRealtimeConnectionOpened,
  recordRealtimeMessageSent,
  recordRealtimeReadHub,
  recordRealtimeSyncRequired,
  recordRealtimeWakeNotificationReceived,
  recordRealtimeWakeWaitEnded,
  recordSettlementOperationSignal,
  recordUcpIdempotencyConflict,
  recordUcpIdempotencyReplayed,
  recordUcpOperationCompleted,
  recordUcpSignatureVerificationFailed,
  recordUcpSignedWriteRejected,
} from "@chase-sets/observability";
import { resolveActorFromRequest } from "@chase-sets/auth/server";
import { buildPlatformApiApp, createPlatformApiHost } from "./app";
import { settlementOperationLogFields } from "@chase-sets/settlement/server";
import {
  loadConfig,
  type PlatformApiCatalogAssetStorageConfig,
  type PlatformApiListingPhotoStorageConfig,
} from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { createProductionTaxQuoteResolverBlocker, shouldBlockProductionTaxQuotes } from "./tax-readiness";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "./test-support/provider-gateways";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createPlatformApiPools(config);
await bootstrapPlatformControlPlane(pools.control);
const runtimeLifecycle = createRuntimeLifecycleRegistry();
const controlPlane = createPostgresPlatformControlPlane(pools.control, { lifecycle: runtimeLifecycle });

const paymentProcessorGateway =
  config.paymentProcessor.kind === "stripe"
    ? createStripePaymentProcessorGateway({
        secretKey: config.paymentProcessor.secretKey,
        publishableKey: config.paymentProcessor.publishableKey,
        webhookSecret: config.paymentProcessor.webhookSecret,
        previousWebhookSecrets: config.paymentProcessor.previousWebhookSecrets,
        apiBaseUrl: config.paymentProcessor.apiBaseUrl,
      })
    : createFakePaymentProcessorGateway();
const moneyMovementGateway =
  config.moneyMovement.kind === "stripe"
    ? createStripeConnectMoneyMovementGateway({
        secretKey: config.moneyMovement.secretKey,
        webhookSecret: config.moneyMovement.webhookSecret,
        previousWebhookSecrets: config.moneyMovement.previousWebhookSecrets,
        accountsApi: config.moneyMovement.connectAccountsApi,
        apiBaseUrl: config.moneyMovement.apiBaseUrl,
      })
    : createFakeMoneyMovementGateway();
const settlementOperationsRecorder = {
  record(event: Record<string, unknown>) {
    recordSettlementOperationSignal({
      kind: String(event.kind ?? "unknown"),
      providerName: typeof event.providerName === "string" ? event.providerName : null,
      setupSurface: typeof event.setupSurface === "string" ? event.setupSurface : null,
      safeCategory: typeof event.safeCategory === "string" ? event.safeCategory : null,
      readinessStatus: typeof event.readinessStatus === "string" ? event.readinessStatus : null,
    });
    logger.info("Settlement operation recorded.", {
      type: "settlement.operation",
      ...settlementOperationLogFields(event),
    });
  },
};
const webhookTelemetry = {
  record(event: Parameters<typeof recordProviderWebhookIngestion>[0]) {
    recordProviderWebhookIngestion(event);
    const fields = {
      type: "provider.webhook.ingestion",
      endpoint: event.endpoint,
      failure_class: event.failureClass ?? "none",
      outcome: event.outcome,
      status_code: event.statusCode,
      retryable: event.retryable,
      provider_event_id: event.providerEventId ?? null,
      event_kind: event.eventKind ?? null,
    };
    if (event.outcome === "failed") {
      logger.error("Provider webhook ingestion failed.", fields);
    } else if (event.failureClass) {
      logger.warn("Provider webhook ingestion classified.", fields);
    } else {
      logger.info("Provider webhook ingestion completed.", fields);
    }
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
const postageWebhookGateway =
  config.postage.kind === "easypost"
    ? createEasyPostPostageWebhookGateway({
        webhookSecret: config.postage.webhookSecret,
      })
    : undefined;
const socialLoginProviders = [
  ...(config.socialLogin.google
    ? [
        createGoogleSocialLoginProvider({
          clientId: config.socialLogin.google.clientId,
          clientSecret: config.socialLogin.google.clientSecret,
        }),
      ]
    : []),
  ...(config.socialLogin.facebook
    ? [
        createFacebookSocialLoginProvider({
          clientId: config.socialLogin.facebook.clientId,
          clientSecret: config.socialLogin.facebook.clientSecret,
        }),
      ]
    : []),
];
const mobileMessageWebhookGateway =
  config.mobileMessaging.kind === "twilio"
    ? createTwilioMessagingWebhookGateway({
        authToken: config.mobileMessaging.authToken,
        requireSignature: config.mobileMessaging.requireWebhookSignature,
      })
    : undefined;
const emailWebhookGateway = createSesEmailWebhookGateway();
const catalogAssetStorage = createCatalogAssetStorage(config.catalogAssetStorage);
const tcgplayerAutomationCatalogClient = config.tcgplayerAutomation
  ? createTcgplayerAutomationCatalogClient(
      createTcgplayerAutomationHttpClients(
        createPostgresTcgplayerAutomationHttpConfigStore(pools.catalog, config.tcgplayerAutomation),
      ),
    )
  : undefined;
const sourceObservationTelemetry = createSourceObservationTelemetry();
const checkoutObservabilityTelemetry = createCheckoutObservabilityTelemetry();
const waitlistAnalyticsRecorder = {
  record(event: {
    event: string;
    section?: string | null;
    target?: string | null;
    field?: string | null;
    role?: string | null;
    interest?: string | null;
    variant?: string | null;
    status?: string | null;
    page_path?: string | null;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    checked?: boolean | null;
  }) {
    recordPublicPresenceWaitlistAnalytics(event);
    logger.info("Public waitlist analytics event captured.", {
      type: "public_presence.waitlist.analytics_event",
      event: event.event,
      section: event.section,
      target: event.target,
      field: event.field,
      role: event.role,
      interest: event.interest,
      variant: event.variant,
      status: event.status,
      page_path: event.page_path,
      utm_source: event.utm_source,
      utm_medium: event.utm_medium,
      utm_campaign: event.utm_campaign,
      checked: event.checked,
    });
  },
};
const listingPhotoStorage = createListingPhotoStorage(config.listingPhotoStorage);
const returnIntakeEvidenceStorage = createReturnIntakeEvidenceStorage(config.listingPhotoStorage);
const supportEvidenceAttachmentStorage = createSupportEvidenceAttachmentStorage(config.listingPhotoStorage);
const taxQuoteResolver = shouldBlockProductionTaxQuotes(
  config.deploymentEnvironment,
  Boolean(config.taxProviderBackedQuotesRequired),
)
  ? createProductionTaxQuoteResolverBlocker()
  : undefined;

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
  runtimeProfile: config.runtimeProfile,
  pools,
  runtimeLifecycle,
  hostPorts: {
    processorGateway: paymentProcessorGateway,
    paymentProcessorPublicConfiguration: paymentProcessorGateway.getPublicConfiguration(),
    webhookTelemetry,
    moneyMovementGateway,
    operationsRecorder: settlementOperationsRecorder,
    postageLabelProvider,
    addressVerificationProvider: postageLabelProvider,
    ...(postageWebhookGateway ? { postageWebhookGateway } : {}),
    catalogAssetStorage,
    ...(tcgplayerAutomationCatalogClient ? { tcgplayerAutomationCatalogClient } : {}),
    sourceObservationTelemetry,
    checkoutObservabilityTelemetry,
    waitlistAnalyticsRecorder,
    listingPhotoStorage,
    returnIntakeEvidenceStorage,
    supportEvidenceAttachmentStorage,
    ...(taxQuoteResolver ? { taxQuoteResolver } : {}),
    socialLoginProviders,
    adminGoogleWorkspaceSso: config.adminGoogleWorkspaceSso,
    registrationAdmission: config.registrationAdmission,
    securityLifetimes: config.authSecurityLifetimes,
    searchEmbeddingConfig: config.discoverySearchEmbeddings,
    searchTelemetry: {
      recordRetrievalMode: (retrievalMode: "lexical" | "rescue" | "hybrid" | "structured") =>
        recordDiscoverySearchQuerySignal({ retrievalMode }),
    },
    emailWebhookGateway,
    ...(mobileMessageWebhookGateway ? { mobileMessageWebhookGateway } : {}),
  },
});
const realtimeStores = runtime.mountedContexts
  .filter(
    (entry) =>
      entry.contextName === "catalog" || entry.contextName === "discovery" || entry.contextName === "marketplace",
  )
  .map((entry) => ({
    contextName: entry.contextName,
    db: entry.pool,
    notificationWaiterPool: entry.notificationWaiterPool ?? entry.pool,
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
const realtimeWakeSignal = config.realtime.wakeSignalEnabled
  ? createPlatformRealtimeWakeSignal(
      [...new Set(realtimeStores.map((store) => store.notificationWaiterPool))],
      realtimeObserver,
    )
  : undefined;
if (realtimeWakeSignal?.stop) {
  runtimeLifecycle.register({
    name: "platform-api.realtime-wake-signal",
    stop: () => realtimeWakeSignal.stop?.() ?? Promise.resolve(),
  });
}
const ucpObserver = {
  signedWriteRejected: (event) => {
    recordUcpSignedWriteRejected(event);
    logger.warn("UCP signed write rejected.", {
      type: "ucp.signed_write.rejected",
      ...event,
    });
  },
  signatureVerificationFailed: (event) => {
    recordUcpSignatureVerificationFailed(event);
    logger.warn("UCP signature verification failed.", {
      type: "ucp.signature_verification.failed",
      ...event,
    });
  },
  idempotencyReplayed: (event) => {
    recordUcpIdempotencyReplayed(event);
    logger.info("UCP idempotent response replayed.", {
      type: "ucp.idempotency.replayed",
      transport: event.transport,
      operation: event.operation,
      agentProfileUrl: event.agentProfileUrl,
    });
  },
  idempotencyConflict: (event) => {
    recordUcpIdempotencyConflict(event);
    logger.warn("UCP idempotency conflict.", {
      type: "ucp.idempotency.conflict",
      transport: event.transport,
      operation: event.operation,
      agentProfileUrl: event.agentProfileUrl,
    });
  },
  operationCompleted: (event) => {
    recordUcpOperationCompleted(event);
    logger.info("UCP operation completed.", {
      type: "ucp.operation.completed",
      ...event,
    });
  },
  toolCallLimited: (event) => {
    logger.warn("UCP MCP tool call limited.", {
      type: "ucp.mcp.tool_call.limited",
      ...event,
    });
  },
  agentGuardrailTriggered: (event) => {
    logger.warn("Agent grant guardrail triggered.", {
      type: "ucp.agent_guardrail.triggered",
      ...event,
    });
  },
} satisfies UcpRuntimeObserver;
// Durable, queryable read model over the same audit records — powers the connected-agents
// activity view. This persists off the existing sink rather than opening a
// second logging path; the fire-and-forget write below never blocks or fails the request.
const mcpAuditLog = createPostgresMcpAuditLog(pools.control);
const mcpAudit = (record: McpAuditRecord) => {
  recordMcpAuditRecord(record);
  const logFields = {
    type: "mcp.audit.record",
    outcome: record.outcome,
    method: record.method,
    toolName: record.toolName,
    resourceUriPresent: record.resourceUri ? true : undefined,
    actorId: record.actorId,
    accountId: record.accountId,
    agentGrantId: record.agentGrantId,
    auditEventName: record.auditEventName,
    targetType: record.targetType,
    reason: record.reason,
    limitKind: record.limitKind,
  };

  void mcpAuditLog.record(record).catch((error) => {
    logger.warn("Failed to persist MCP audit record.", { type: "mcp.audit.persist_failed", error });
  });

  if (record.outcome === "allowed") {
    logger.info("Native MCP invocation completed.", logFields);
    return;
  }

  logger.warn("Native MCP invocation did not complete.", logFields);
};
const realtimeStreamLimiter = await createPlatformRealtimeStreamLimiter();
configureDefaultDurableJobStreamLimiter(
  realtimeStreamLimiter.limiter
    ? createDurableJobStreamLimiterFromRealtime(realtimeStreamLimiter.limiter, {
        maxActiveStreams: config.realtime.maxActiveStreams,
        maxActiveStreamsPerConnectionKey: config.realtime.maxActiveStreamsPerConnectionKey,
      })
    : undefined,
);
const mcpToolCallLimiter = realtimeStreamLimiter.limiter
  ? createMcpToolCallLimiterFromRealtime(realtimeStreamLimiter.limiter, config.mcpToolCallLimits)
  : undefined;
const agentGrantRateLimiter = createAgentGrantRateLimiter(config.agentGrantRateLimit);
const agentGrantConsent = createPostgresAgentGrantConsentDirectory(pools.control);
const agentGrantSpendPolicy = createPostgresAgentGrantSpendPolicy(pools.control, {
  ...config.agentGrantSpendCap,
  mandateResolver: agentGrantConsent.resolveMandate,
});
const drainState = createProcessDrainState();
const workSignalStore = createPostgresWorkSignalStore(pools.workSignal, {
  ...(config.readConsistency?.wakeBeforeWaitEnabled || config.readConsistency?.readinessNotificationsEnabled
    ? {
        readConsistencyGateway: {
          observer: { wakeEnqueueCompleted: recordProjectionFreshnessWakeEnqueue },
          waitForReadinessNotifications: config.readConsistency?.readinessNotificationsEnabled,
        },
      }
    : {}),
});
const app = buildPlatformApiApp(runtime, {
  runtimeProfile: config.runtimeProfile,
  internalAuthSecret: config.internalAuthSecret,
  adminRegistrationEnabled: config.adminRegistrationEnabled,
  controlPlane,
  workSignalStore,
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  readConsistencyAuditLogger: logger,
  readConsistency: {
    ...config.readConsistency,
    workSignalGateway: workSignalStore.readConsistencyGateway,
  },
  readinessChecks: [
    {
      name: "control.database",
      check: async () => {
        await pools.control.query("SELECT 1");
      },
    },
  ],
  resolveActor: (request) =>
    resolveActorFromRequest(runtime.services.auth as Parameters<typeof resolveActorFromRequest>[0], request, {
      linkedPlatformAuthorizations: (
        runtime.services.identity as Readonly<{
          linkedPlatformAuthorizations: NonNullable<
            Parameters<typeof resolveActorFromRequest>[2]
          >["linkedPlatformAuthorizations"];
        }>
      ).linkedPlatformAuthorizations,
    }),
  realtimeObserver,
  realtimeWakeSignal,
  realtimeStreamLimiter: realtimeStreamLimiter.limiter,
  realtimeActiveConnectionCount: () => realtimeActiveConnectionCount,
  isDraining: drainState.isDraining,
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
  ucp: {
    businessSigningKeys: config.ucpBusinessSigningKeys,
    idempotencyStore: createPostgresUcpIdempotencyStore(pools.control, {
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    }),
    signatureVerification: {
      keyResolver: createUcpProfileKeyResolver({ db: pools.control }),
      createdFreshnessWindowMs: config.ucpSignatureCreatedFreshnessWindowMs,
    },
    observer: ucpObserver,
    mcpToolCallLimiter,
    agentGrantRateLimiter,
  },
  agentGrantSpendPolicy,
  agentGrantConsent,
  agentGrantActivity: mcpAuditLog,
  mcp: {
    audit: mcpAudit,
    idempotencyStore: createPostgresUcpIdempotencyStore<unknown>(pools.control, {
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    }),
    toolCallLimiter: mcpToolCallLimiter,
    agentGrantRateLimiter,
  },
  realtimeResourceLimits: {
    maxTopicsPerStream: config.realtime.maxTopicsPerStream,
    maxActiveStreams: config.realtime.maxActiveStreams,
    maxActiveStreamsPerConnectionKey: config.realtime.maxActiveStreamsPerConnectionKey,
  },
});
mountLocalCatalogAssetRoute(app, config.catalogAssetStorage);
mountLocalListingPhotoRoute(app, config.listingPhotoStorage);
const realtimeRetentionSweeper = config.realtime.backgroundMaintenanceEnabled
  ? createRealtimeRetentionSweeper({
      stores: realtimeStores,
      intervalMs: config.realtime.retentionPruneIntervalMs,
      observer: realtimeObserver,
      onError: (error) => {
        logger.error("Realtime retention sweep failed.", {
          type: "realtime.retention.failed",
          error,
        });
      },
    })
  : undefined;
if (realtimeRetentionSweeper) {
  void realtimeRetentionSweeper.sweep();
}

function createCatalogAssetStorage(storageConfig: PlatformApiCatalogAssetStorageConfig): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
}

function createSourceObservationTelemetry() {
  return {
    recordProviderOptionQuery: recordCatalogIntegrationOptionQuery,
    recordIntegrationJob: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "integration-job" }),
    recordBulkReviewWorkUnit: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "bulk-review-work-unit" }),
    recordControlPlaneEvent: recordCatalogControlPlaneEvent,
  };
}

function createCheckoutObservabilityTelemetry() {
  return {
    recordCheckoutEvent: recordCheckoutObservabilityEvent,
  };
}

function createListingPhotoStorage(storageConfig: PlatformApiListingPhotoStorageConfig): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
}

function createReturnIntakeEvidenceStorage(storageConfig: PlatformApiListingPhotoStorageConfig): ObjectStorage {
  if (storageConfig.kind === "s3") {
    return createS3ObjectStorage({ ...storageConfig, publicBaseUrl: "private://return-intake-evidence" });
  }
  return createFilesystemObjectStorage({
    rootDir: `${storageConfig.rootDir}/private-return-intake`,
    publicBaseUrl: "private://return-intake-evidence",
  });
}

function createSupportEvidenceAttachmentStorage(storageConfig: PlatformApiListingPhotoStorageConfig): ObjectStorage {
  if (storageConfig.kind === "s3") {
    return createS3ObjectStorage({ ...storageConfig, publicBaseUrl: "private://support-evidence" });
  }
  return createFilesystemObjectStorage({
    rootDir: `${storageConfig.rootDir}-private-support-evidence`,
    publicBaseUrl: "private://support-evidence",
  });
}

function mountLocalCatalogAssetRoute(
  app: ReturnType<typeof buildPlatformApiApp>,
  storageConfig: PlatformApiCatalogAssetStorageConfig,
) {
  if (storageConfig.kind !== "filesystem") {
    return;
  }

  const routePrefix = "/catalog-assets/";
  app.get("/catalog-assets/*", async (c) => {
    const key = c.req.path.slice(routePrefix.length);
    const object = await readFilesystemObject(storageConfig.rootDir, key);
    if (!object) {
      return c.notFound();
    }

    return new Response(toArrayBuffer(object.body), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": object.contentType,
      },
    });
  });
}

function mountLocalListingPhotoRoute(
  app: ReturnType<typeof buildPlatformApiApp>,
  storageConfig: PlatformApiListingPhotoStorageConfig,
) {
  if (storageConfig.kind !== "filesystem") {
    return;
  }

  const routePrefix = "/marketplace-listing-photos/";
  app.get("/marketplace-listing-photos/*", async (c) => {
    const key = c.req.path.slice(routePrefix.length);
    const object = await readFilesystemObject(storageConfig.rootDir, key);
    if (!object) {
      return c.notFound();
    }

    return new Response(toArrayBuffer(object.body), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": object.contentType,
      },
    });
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const realtimePartitionMaintainerStores = [...new Set(realtimeStores.map((store) => store.db))].map((db) => {
  const contextNames = realtimeStores.filter((store) => store.db === db).map((store) => store.contextName);
  return { db, contextNames };
});
const realtimePartitionMaintainers = config.realtime.backgroundMaintenanceEnabled
  ? realtimePartitionMaintainerStores.map((store) =>
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
    )
  : [];
for (const maintainer of realtimePartitionMaintainers) {
  void maintainer.maintain();
}

startGracefulHttpServer({
  name: "platform-api",
  port: config.port,
  serve,
  fetch: app.fetch,
  drainState,
  logger,
  onListening: (info) => {
    logger.info("Platform API listening.", {
      type: "platform-api.started",
      port: info.port,
    });
  },
  onDrainStart: [
    () => {
      logger.info("Platform API stopping background realtime maintenance.", {
        type: "platform-api.drain.background_stopping",
      });
      realtimeRetentionSweeper?.stop();
      for (const maintainer of realtimePartitionMaintainers) {
        maintainer.stop();
      }
    },
  ],
  onShutdown: [
    async () => {
      await runtimeLifecycle.stopAll({ logger });
    },
    async () => realtimeStreamLimiter.stop?.(),
    async () => {
      await runWithRuntimeLifecycleTimeout("platform-api.close-pools", () => closePlatformApiPools(pools), { logger });
    },
    async () => observability.shutdown(),
  ],
});

async function createPlatformRealtimeStreamLimiter(): Promise<
  Readonly<{
    limiter?: RealtimeStreamLimiter;
    stop?: () => Promise<void>;
  }>
> {
  if (config.realtime.streamLimiter.kind === "postgres") {
    return {
      limiter: createPostgresRealtimeStreamLimiter({
        pool: pools.control,
        leaseTtlMs: config.realtime.streamLimiter.leaseTtlMs,
        renewIntervalMs: config.realtime.streamLimiter.renewIntervalMs,
        onRenewalError: (error) => {
          logger.warn("Realtime Postgres stream lease renewal failed; the lease will retry on the next interval.", {
            type: "realtime.stream_limiter.postgres.renewal_failed",
            error,
          });
        },
      }),
    };
  }

  if (config.realtime.streamLimiter.kind === "local") {
    return {
      limiter: createInMemoryRealtimeStreamLimiter(),
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
          return typeof result === "number" || typeof result === "string" ? result : Number(result ?? 0);
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

function createPlatformRealtimeWakeSignal(
  pools: readonly { connect?: () => Promise<unknown> }[],
  observer: Pick<RealtimeObserver, "wakeNotificationReceived">,
): RealtimeWakeSignal | undefined {
  // One composite work-signal waiter per unique realtime context pool. The
  // waiter connects lazily and circuit-breaks reconnects, so listener
  // failures surface here at most once per cooldown instead of at startup.
  const wakeSignals = pools
    .filter((pool) => typeof pool.connect === "function")
    .map((pool) =>
      createRealtimeOutboxWakeSignal(pool as Parameters<typeof createRealtimeOutboxWakeSignal>[0], {
        observer,
        onListenerUnavailable: (error) => {
          logger.warn("Realtime Postgres wake signal unavailable for a context pool.", {
            type: "realtime.wake_signal.unavailable",
            error,
          });
        },
      }),
    );

  return createMergedRealtimeWakeSignal(wakeSignals);
}
