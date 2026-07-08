import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from "@opentelemetry/api";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type ObservabilityConfig = Readonly<{
  enabled: boolean;
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment: string;
  otlpEndpoint?: string;
  otlpHeaders: Readonly<Record<string, string>>;
  tracesSampler: string;
  tracesSamplerArg?: string;
  logFilePath?: string;
  logLevel: LogLevel;
  logExportMaxInFlight: number;
  logExportQueueSize: number;
  resourceAttributes: Readonly<Record<string, string>>;
}>;

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = Readonly<{
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}>;

export type LogFields = Readonly<Record<string, unknown>>;

export type ObservabilityRuntime = Readonly<{
  config: ObservabilityConfig;
  logger: Logger;
  shutdown: () => Promise<void>;
}>;

const DEFAULT_SERVICE_NAME = "platform-api";
const DEFAULT_ENVIRONMENT = "local";
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENSITIVE_FIELD_RE = /(authorization|cookie|token|secret|password|email|address|card|key|apiKey)/i;
const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} satisfies Record<LogLevel, number>;
const DEFAULT_LOG_EXPORT_MAX_IN_FLIGHT = 4;
const DEFAULT_LOG_EXPORT_QUEUE_SIZE = 100;
const MAX_LOG_EXPORT_MAX_IN_FLIGHT = 16;
const MAX_LOG_EXPORT_QUEUE_SIZE = 1_000;

const OBSERVABILITY_SCOPE_NAME = "@chase-sets/observability";
const tracer = trace.getTracer(OBSERVABILITY_SCOPE_NAME);
const requestCounter = lazyCounter("chase_sets_http_server_requests_total");
const requestDuration = lazyHistogram("chase_sets_http_server_request_duration_ms", {
  unit: "ms",
});
const eventStoreCounter = lazyCounter("chase_sets_event_store_operations_total");
const eventStoreDuration = lazyHistogram("chase_sets_event_store_operation_duration_ms", {
  unit: "ms",
});
const eventStoreAppendAdvisoryLockHoldDuration = lazyHistogram(
  "chase_sets_event_store_append_advisory_lock_hold_duration_ms",
  {
    unit: "ms",
  },
);
const projectorCounter = lazyCounter("chase_sets_projection_runs_total");
const projectorDuration = lazyHistogram("chase_sets_projection_run_duration_ms", {
  unit: "ms",
});
const workerCounter = lazyCounter("chase_sets_worker_runs_total");
const workerDuration = lazyHistogram("chase_sets_worker_run_duration_ms", {
  unit: "ms",
});
const realtimeConnectionCounter = lazyCounter("chase_sets_realtime_connections_total");
const realtimeActiveConnections = lazyUpDownCounter("chase_sets_realtime_active_connections");
const realtimeStreamDuration = lazyHistogram("chase_sets_realtime_stream_duration_ms", {
  unit: "ms",
});
const realtimeAuthorizationRejectedCounter = lazyCounter("chase_sets_realtime_authorization_rejected_total");
const realtimeBatchSize = lazyHistogram("chase_sets_realtime_batch_messages", {
  unit: "{message}",
});
const realtimeMessageCounter = lazyCounter("chase_sets_realtime_messages_total");
const realtimePayloadBytes = lazyHistogram("chase_sets_realtime_payload_bytes", {
  unit: "By",
});
const realtimeSyncRequiredCounter = lazyCounter("chase_sets_realtime_sync_required_total");
const realtimeWakeCounter = lazyCounter("chase_sets_realtime_wake_waits_total");
const realtimeWakeNotificationCounter = lazyCounter("chase_sets_realtime_wake_notifications_total");
const realtimeReadHubCounter = lazyCounter("chase_sets_realtime_read_hub_total");
const realtimeTopicLag = lazyHistogram("chase_sets_realtime_topic_lag", {
  unit: "{message}",
});
const ucpOperationCounter = lazyCounter("chase_sets_ucp_operations_total");
const ucpSignedWriteRejectedCounter = lazyCounter("chase_sets_ucp_signed_write_rejected_total");
const ucpSignatureVerificationFailedCounter = lazyCounter("chase_sets_ucp_signature_verification_failed_total");
const ucpIdempotencyCounter = lazyCounter("chase_sets_ucp_idempotency_total");
const mcpAuditCounter = lazyCounter("chase_sets_mcp_audit_records_total");
const publicPresenceWaitlistEventCounter = lazyCounter("chase_sets_public_presence_waitlist_events_total");
const itemDetailRailEventCounter = lazyCounter("chase_sets_marketplace_item_detail_rail_events_total");
const settlementOperationCounter = lazyCounter("chase_sets_settlement_operations_total");
const checkoutObservabilityEventCounter = lazyCounter("chase_sets_checkout_observability_events_total");
const postWriteConsistencyEventCounter = lazyCounter("chase_sets_post_write_consistency_events_total");
const catalogIntegrationOptionQueryCounter = lazyCounter("chase_sets_catalog_integration_option_queries_total");
const catalogIntegrationJobCounter = lazyCounter("chase_sets_catalog_integration_jobs_total");
const catalogControlPlaneEventCounter = lazyCounter("chase_sets_catalog_control_plane_events_total");
const projectionFreshnessEvaluationCounter = lazyCounter("chase_sets_projection_freshness_evaluations_total");
const projectionFreshnessWaitDuration = lazyHistogram("chase_sets_projection_freshness_wait_duration_ms", {
  unit: "ms",
});
const projectionFreshnessPendingCounter = lazyCounter("chase_sets_projection_freshness_pending_total");
const projectionFreshnessPendingLag = lazyHistogram("chase_sets_projection_freshness_pending_lag", {
  unit: "{global_position}",
});
const projectionFreshnessWakeRequestCounter = lazyCounter("chase_sets_projection_freshness_wake_requests_total");
const projectionFreshnessWakeEnqueueDuration = lazyHistogram(
  "chase_sets_projection_freshness_wake_enqueue_duration_ms",
  {
    unit: "ms",
  },
);
const projectionFreshnessWorkSignalErrorCounter = lazyCounter(
  "chase_sets_projection_freshness_work_signal_errors_total",
);
const projectionWakeNotificationCounter = lazyCounter("chase_sets_projection_wake_notifications_total");
const projectionWakeNotificationPayloadBytes = lazyHistogram("chase_sets_projection_wake_notification_payload_bytes", {
  unit: "By",
});
const projectionWakeNotificationAge = lazyHistogram("chase_sets_projection_wake_notification_age_ms", {
  unit: "ms",
});
const projectionWakeRelayCatchUpCounter = lazyCounter("chase_sets_projection_wake_relay_catch_up_total");
const projectionWakeRelayCatchUpDuration = lazyHistogram("chase_sets_projection_wake_relay_catch_up_duration_ms", {
  unit: "ms",
});
const projectionWakeRelayCatchUpEventsCounter = lazyCounter("chase_sets_projection_wake_relay_catch_up_events_total");
const projectionWakeRelayFanOutCounter = lazyCounter("chase_sets_projection_wake_relay_fan_out_total");
const projectionWakeRelayFanOutIntentsCounter = lazyCounter("chase_sets_projection_wake_relay_fan_out_intents_total");
const projectionInterestIndexLookupCounter = lazyCounter("chase_sets_projection_interest_index_lookups_total");
const projectionInterestIndexLookupDuration = lazyHistogram("chase_sets_projection_interest_index_lookup_duration_ms", {
  unit: "ms",
});
const projectionWakeIntentEnqueueOutcomeCounter = lazyCounter(
  "chase_sets_projection_wake_intent_enqueue_outcomes_total",
);
const projectionWakeIntentCounter = lazyCounter("chase_sets_projection_wake_intents_total");
const projectionWakeIntentAttemptsExhaustedCounter = lazyCounter(
  "chase_sets_projection_wake_intent_attempts_exhausted_total",
);
const projectionWakeIntentQueueAge = lazyHistogram("chase_sets_projection_wake_intent_queue_age_ms", {
  unit: "ms",
});
const projectionWakeIntentProcessingDuration = lazyHistogram("chase_sets_projection_wake_intent_processing_ms", {
  unit: "ms",
});

export type PublicPresenceWaitlistAnalyticsSignal = Readonly<{
  event: string;
  section?: string | null;
  target?: string | null;
  field?: string | null;
  role?: string | null;
  interest?: string | null;
  variant?: string | null;
  status?: string | null;
}>;

export type ItemDetailRailAnalyticsSignal = Readonly<{
  event: string;
  intent?: string | null;
  workflow?: string | null;
  selection?: string | null;
  topic?: string | null;
  outcome?: string | null;
  gate?: string | null;
  viewer?: string | null;
  surface?: string | null;
}>;

export type CheckoutObservabilityEventSignal = Readonly<{
  eventName: `checkout.${string}`;
  telemetryClass: string;
  alertClass: string;
  entrySource: string;
  actorMode: string;
  scenarioState: string;
  visibleState: string;
  sideEffectStatus: string;
  operatorSignalRequired?: boolean;
  readinessContract?: string | null;
  readinessSnapshotState?: string | null;
  sourceRevisionState?: string | null;
  freshWriteReceiptPresence?: string | null;
  supportReferencePresent?: boolean;
  performanceBudgetId?: string | null;
  providerCategory?: string | null;
  riskCategory?: string | null;
  downstreamStatus?: string | null;
  capabilityDecision?: string | null;
  freshStateScanResult?: string | null;
}>;

export type PostWriteConsistencyOutcome =
  | "projection_hit"
  | "fallback_used"
  | "fallback_failed"
  | "missing_strategy"
  | "optimistic_applied"
  | "freshness_timeout"
  | "rollback"
  | "reconciliation"
  | "stale_response_discard"
  | "handoff_parsed"
  | "handoff_satisfied"
  | "handoff_pending"
  | "handoff_expired"
  | "handoff_invalid"
  | "handoff_malformed"
  | "handoff_permanent"
  | "navigation_encoded"
  | "navigation_missing_receipt"
  | "read_data"
  | "read_pending"
  | "read_permanent";

export type PostWriteConsistencyEventSignal = Readonly<{
  boundedContextName: string;
  surface: string;
  strategy: string;
  outcome: PostWriteConsistencyOutcome;
  routeId?: string | null;
  routeTemplate?: string | null;
  correctionSource?: string | null;
  actorMode?: string | null;
  recoveryAction?: string | null;
  freshnessOutcome?: string | null;
  sourceContextName?: string | null;
  projectionName?: string | null;
  readModelTable?: string | null;
  fallbackId?: string | null;
  fallbackCategory?: string | null;
}>;

export type CatalogIntegrationOptionQuerySignal = Readonly<{
  providerKey: string;
  queryKind: string;
  cacheStatus: string;
  cacheSource: string;
  result: "success" | "failure";
  degraded: boolean;
  cacheOnly: boolean;
  forceRefresh: boolean;
}>;

export type CatalogIntegrationJobSignal = Readonly<{
  jobKind: string;
  result: string;
  operation: "integration-job" | "bulk-review-work-unit";
}>;

export type CatalogControlPlaneEventSignal = Readonly<{
  eventName: string;
  providerKey: string;
  unitKey: string;
  scopeId: string;
  profileRef: string;
  jobRefState: string;
  observationStatus: string;
  observationCountBucket: string;
  promotionResult: string;
  promotionCountBucket: string;
  blockerCategory: string;
  detourTarget: string;
  detourOutcome: string;
  roleBucket: string;
  readModelFreshness: string;
}>;

export type ProjectionFreshnessAuditSignal = Readonly<{
  type: "read-after-write.freshness";
  outcome: string;
  method: string;
  mountPath: string;
  routePaths: readonly string[];
  readAfterWriteHeaderPresent: boolean;
  readTargetContextHeaderPresent: boolean;
  readTargetContextHeaderValid: boolean;
  requestedTargetContextName: string | null;
  targetContextNames: readonly string[];
  waitMode: string;
  durationMs: number;
  receiptSourceContextNames: readonly string[];
  receiptSourceCount: number;
  receiptEventCount: number;
  dependencies: readonly Readonly<{
    targetContextName: string;
    projectionName: string;
  }>[];
  wakeRequestCount: number;
  workSignalError: "present" | null;
  pending: readonly Readonly<{
    targetContextName: string;
    projectionName: string;
    sourceContextName: string;
    globalPositionLag: string;
    state: string;
    lastError: "present" | null;
  }>[];
}>;

export type ProjectionFreshnessEvaluationMetric = Readonly<{
  attributes: Attributes;
  durationMs: number;
}>;

export type ProjectionFreshnessPendingMetric = Readonly<{
  attributes: Attributes;
  globalPositionLag: number;
}>;

export type ProjectionFreshnessWakeRequestMetric = Readonly<{
  attributes: Attributes;
  wakeRequestCount: number;
}>;

export type ProjectionFreshnessWakeEnqueueSignal = Readonly<{
  outcome: "completed" | "failed";
  priorityLane: string;
  requestCount: number;
  enqueuedCount: number;
  durationMs: number;
  sourceContextName?: string | null;
  targetContextName?: string | null;
  projectionName?: string | null;
  mountPath?: string | null;
  routePath?: string | null;
}>;

export type ProjectionFreshnessWakeEnqueueMetric = Readonly<{
  attributes: Attributes;
  durationMs: number;
}>;

export type ProjectionFreshnessWorkSignalErrorMetric = Readonly<{
  attributes: Attributes;
}>;

export type ProjectionWakeNotificationEmittedSignal = Readonly<{
  sourceContextName: string;
  streamCategory: string;
  eventCount: number;
  payloadBytes: number;
  emittedAt?: string | null;
}>;

export type ProjectionWakeRelayCatchUpSignal = Readonly<{
  sourceContextName: string;
  reason: "startup" | "notification" | "reconnect";
  eventCount: number;
  cursorAdvanceCount: number;
  durationMs: number;
}>;

export type ProjectionWakeRelayFanOutSignal = Readonly<{
  sourceContextName: string | null;
  status: "enqueued" | "skipped" | "failed";
  reason?: string | null;
  priorityLane?: string | null;
  routingMode?: string | null;
  intentCount: number;
  enqueuedCount: number;
  notificationAgeMs?: number | null;
}>;

export type ProjectionInterestIndexLookupSignal = Readonly<{
  sourceContextName: string;
  targetContextName?: string | null;
  projectionName?: string | null;
  priorityLane?: string | null;
  outcome: "matched" | "no-interests" | "stale-index" | "failed";
  intentCount: number;
  durationMs: number;
}>;

export type ProjectionWakeIntentOutcomeSignal = Readonly<{
  outcome:
    | "completed"
    | "already-satisfied"
    | "not-ready"
    | "deferred"
    | "unknown-target"
    | "run-failed"
    | "attempts-exhausted"
    | "claim-lost";
  priorityLane: string;
  origin: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  queueAgeMs: number;
  attemptCount: number;
  processingDurationMs?: number | null;
  requeued?: boolean;
}>;

export type ProjectionWakeIntentEnqueueOutcomeSignal = Readonly<{
  outcome: "created" | "coalesced" | "requeued_completed" | "requeued_expired" | "blocked";
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  priorityLane: string;
  origin: string;
  routingMode?: string | null;
}>;

export type ProjectionWakeIntentEnqueueOutcomeMetric = Readonly<{
  attributes: Attributes;
}>;

export type EventStoreAppendAdvisoryLockHoldSignal = Readonly<{
  durationMs: number;
  outcome: "committed" | "rolled_back" | "released";
  holderKind?: string | null;
  targetContextName?: string | null;
  sourceContextName?: string | null;
  projectionName?: string | null;
  subscriptionName?: string | null;
}>;

let runtime: ObservabilityRuntime | null = null;

type Meter = ReturnType<typeof metrics.getMeter>;
type CounterOptions = Parameters<Meter["createCounter"]>[1];
type HistogramOptions = Parameters<Meter["createHistogram"]>[1];
type UpDownCounterOptions = Parameters<Meter["createUpDownCounter"]>[1];

function lazyCounter(name: string, options?: CounterOptions): Counter {
  let instrument: Counter | undefined;
  return {
    add(value, attributes, activeContext) {
      const counter = runtime?.config.enabled
        ? (instrument ??= metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createCounter(name, options))
        : metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createCounter(name, options);
      counter.add(value, attributes, activeContext);
    },
  };
}

function lazyHistogram(name: string, options?: HistogramOptions): Histogram {
  let instrument: Histogram | undefined;
  return {
    record(value, attributes, activeContext) {
      const histogram = runtime?.config.enabled
        ? (instrument ??= metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createHistogram(name, options))
        : metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createHistogram(name, options);
      histogram.record(value, attributes, activeContext);
    },
  };
}

function lazyUpDownCounter(name: string, options?: UpDownCounterOptions): UpDownCounter {
  let instrument: UpDownCounter | undefined;
  return {
    add(value, attributes, activeContext) {
      const counter = runtime?.config.enabled
        ? (instrument ??= metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createUpDownCounter(name, options))
        : metrics.getMeter(OBSERVABILITY_SCOPE_NAME).createUpDownCounter(name, options);
      counter.add(value, attributes, activeContext);
    },
  };
}

export function loadObservabilityConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: Readonly<{
    serviceName?: string;
    serviceVersion?: string;
  }> = {},
): ObservabilityConfig {
  return {
    enabled: env.OBSERVABILITY_ENABLED !== "false",
    serviceName: nonEmpty(env.OTEL_SERVICE_NAME) ?? defaults.serviceName ?? DEFAULT_SERVICE_NAME,
    serviceVersion: nonEmpty(env.OTEL_SERVICE_VERSION) ?? defaults.serviceVersion,
    deploymentEnvironment: nonEmpty(env.DEPLOYMENT_ENVIRONMENT) ?? DEFAULT_ENVIRONMENT,
    otlpEndpoint: nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? DEFAULT_OTLP_ENDPOINT,
    otlpHeaders: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    tracesSampler: nonEmpty(env.OTEL_TRACES_SAMPLER) ?? "parentbased_traceidratio",
    tracesSamplerArg: nonEmpty(env.OTEL_TRACES_SAMPLER_ARG) ?? (env.NODE_ENV === "production" ? "0.1" : "1.0"),
    logFilePath: nonEmpty(env.LOG_FILE_PATH),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logExportMaxInFlight: parsePositiveInteger(
      env.LOG_EXPORT_MAX_IN_FLIGHT,
      DEFAULT_LOG_EXPORT_MAX_IN_FLIGHT,
      MAX_LOG_EXPORT_MAX_IN_FLIGHT,
    ),
    logExportQueueSize: parseNonNegativeInteger(
      env.LOG_EXPORT_QUEUE_SIZE,
      DEFAULT_LOG_EXPORT_QUEUE_SIZE,
      MAX_LOG_EXPORT_QUEUE_SIZE,
    ),
    resourceAttributes: parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
  };
}

export function startObservability(config = loadObservabilityConfig()): ObservabilityRuntime {
  if (runtime) {
    return runtime;
  }

  const logger = createLogger(config);

  if (!config.enabled) {
    runtime = {
      config,
      logger,
      shutdown: async () => undefined,
    };
    logger.info("Observability is disabled.", { type: "observability.disabled" });
    return runtime;
  }

  applyOtelEnvironmentDefaults(config);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": config.serviceName,
      ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
      "deployment.environment": config.deploymentEnvironment,
      ...config.resourceAttributes,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${trimTrailingSlash(config.otlpEndpoint)}/v1/traces`,
      headers: config.otlpHeaders,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${trimTrailingSlash(config.otlpEndpoint)}/v1/metrics`,
        headers: config.otlpHeaders,
      }),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    logger.info("Observability started.", {
      type: "observability.started",
      otlpEndpoint: config.otlpEndpoint,
      tracesSampler: config.tracesSampler,
      tracesSamplerArg: config.tracesSamplerArg,
    });
    void warnIfCollectorUnavailable(config, logger);
  } catch (error) {
    logger.warn("Observability failed to start; continuing without telemetry export.", {
      type: "observability.start_failed",
      error: errorToFields(error),
    });
  }

  runtime = {
    config,
    logger,
    shutdown: async () => {
      await sdk.shutdown().catch((error: unknown) => {
        logger.warn("Observability shutdown failed.", {
          type: "observability.shutdown_failed",
          error: errorToFields(error),
        });
      });
    },
  };

  return runtime;
}

export function createObservabilityPrelude(serviceName: string): ObservabilityRuntime {
  return startObservability(
    loadObservabilityConfig(process.env, {
      serviceName,
      serviceVersion: "0.1.0",
    }),
  );
}

export function getObservabilityRuntime(): ObservabilityRuntime {
  return runtime ?? startObservability();
}

export function createLogger(config = loadObservabilityConfig()): Logger {
  const structuredLogExporter = createStructuredLogExporter(config);

  function write(level: LogLevel, message: string, fields: LogFields = {}) {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[config.logLevel]) {
      return;
    }

    const spanContext = trace.getSpanContext(context.active());
    const entry = sanitizeLogFields({
      timestamp: new Date().toISOString(),
      level,
      message,
      service: config.serviceName,
      environment: config.deploymentEnvironment,
      traceId: spanContext?.traceId,
      spanId: spanContext?.spanId,
      ...fields,
    });
    const line = JSON.stringify(entry);

    writeLogFile(config.logFilePath, line);
    structuredLogExporter(entry);

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export function attachActiveTraceContext(eventContext: EventStoreContext): EventStoreContext {
  const spanContext = trace.getSpanContext(context.active());

  if (!spanContext?.traceId || !spanContext.spanId) {
    return eventContext;
  }

  return {
    ...eventContext,
    trace: {
      ...eventContext.trace,
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceState: spanContext.traceState?.serialize(),
    },
  };
}

export function createHonoObservabilityMiddleware(logger = getObservabilityRuntime().logger) {
  return async function observabilityMiddleware(
    c: {
      req: {
        raw: Request;
        method: string;
        path: string;
      };
      res?: Response;
    },
    next: () => Promise<void>,
  ): Promise<void> {
    const request = c.req.raw;
    const url = new URL(request.url);
    const method = c.req.method.toUpperCase();
    const route = normalizeRouteTemplate(c.req.path || url.pathname);
    const extracted = propagation.extract(context.active(), request.headers, headersGetter);
    const attributes = {
      "http.request.method": method,
      "http.route": route,
      "url.scheme": url.protocol.replace(":", ""),
      "server.address": url.hostname,
    };
    const startedAt = performance.now();

    await context.with(extracted, async () =>
      tracer.startActiveSpan(
        `HTTP ${method} ${route}`,
        {
          kind: SpanKind.SERVER,
          attributes,
        },
        async (span) => {
          let status = 500;
          try {
            await next();
            status = c.res?.status ?? 200;
            span.setAttribute("http.response.status_code", status);
            if (status >= 500) {
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          } catch (error) {
            span.recordException(normalizeError(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
            logger.error("Unhandled request error.", {
              type: "http.request.error",
              route,
              method,
              error: errorToFields(error),
            });
            throw error;
          } finally {
            const durationMs = performance.now() - startedAt;
            const metricAttributes = {
              method,
              route,
              status_class: toStatusClass(status),
            };
            requestCounter.add(1, metricAttributes);
            requestDuration.record(durationMs, metricAttributes);
            logger.info("HTTP request completed.", {
              type: "http.request.completed",
              method,
              route,
              status,
              statusClass: toStatusClass(status),
              durationMs: Math.round(durationMs),
            });
            span.end();
          }
        },
      ),
    );
  };
}

export async function observeEventStoreOperation<T>(
  operation: string,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> {
  return observeOperation({
    name: `event_store.${operation}`,
    attributes,
    counter: eventStoreCounter,
    duration: eventStoreDuration,
    work,
  });
}

export function recordEventStoreAppendAdvisoryLockHold(event: EventStoreAppendAdvisoryLockHoldSignal): void {
  if (!Number.isFinite(event.durationMs)) {
    return;
  }

  eventStoreAppendAdvisoryLockHoldDuration.record(Math.max(0, Math.round(event.durationMs)), {
    outcome: boundedMetricLabel(event.outcome),
    holder_kind: boundedMetricLabel(event.holderKind),
    target_context: boundedMetricLabel(event.targetContextName),
    source_context: boundedMetricLabel(event.sourceContextName),
    projection: boundedMetricLabel(event.projectionName),
    subscription: boundedMetricLabel(event.subscriptionName),
  });
}

export function observeProjectors<TProjector extends { runOnce: () => Promise<{ processed: number }> }>(
  projectors: readonly TProjector[],
  attributes: Attributes = {},
): readonly TProjector[] {
  return projectors.map((projector, index) => ({
    ...projector,
    runOnce: () =>
      observeOperation({
        name: "projection.run_once",
        attributes: {
          ...attributes,
          projector_index: String(index),
        },
        counter: projectorCounter,
        duration: projectorDuration,
        work: projector.runOnce,
      }),
  }));
}

export function observeWorker<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T> {
  return observeOperation({
    name: `worker.${name}`,
    attributes,
    counter: workerCounter,
    duration: workerDuration,
    work,
  });
}

export function recordRealtimeConnectionOpened(
  event: Readonly<{
    storeNames: readonly string[];
    topics: readonly string[];
  }>,
): void {
  realtimeConnectionCounter.add(1, {
    store_count: event.storeNames.length,
    topic_count: event.topics.length,
  });
  realtimeActiveConnections.add(1);
}

export function recordRealtimeConnectionClosed(
  event: Readonly<{
    durationMs: number;
  }>,
): void {
  realtimeActiveConnections.add(-1);
  realtimeStreamDuration.record(event.durationMs);
}

export function recordRealtimeAuthorizationRejected(
  event: Readonly<{
    reason: string;
    topics: readonly string[];
  }>,
): void {
  realtimeAuthorizationRejectedCounter.add(1, {
    reason: event.reason,
    topic_count: event.topics.length,
  });
}

export function recordRealtimeBatchRead(
  event: Readonly<{
    messageCount: number;
    expiredContextCount: number;
    storeNames: readonly string[];
    topicLags?: readonly Readonly<{
      contextName: string;
      topic: string;
      lag: number;
    }>[];
  }>,
): void {
  realtimeBatchSize.record(event.messageCount, {
    store_count: event.storeNames.length,
    expired_context_count: event.expiredContextCount,
  });

  for (const lag of event.topicLags ?? []) {
    realtimeTopicLag.record(lag.lag, {
      context: lag.contextName,
      topic_family: lag.topic.split(":")[0] ?? "unknown",
    });
  }
}

export function recordRealtimeMessageSent(
  event: Readonly<{
    contextName: string;
    eventKind: string;
    payloadBytes?: number;
  }>,
): void {
  realtimeMessageCounter.add(1, {
    context: event.contextName,
    event_kind: event.eventKind,
  });
  if (event.payloadBytes !== undefined) {
    realtimePayloadBytes.record(event.payloadBytes, {
      context: event.contextName,
      event_kind: event.eventKind,
    });
  }
}

export function recordRealtimeSyncRequired(
  event: Readonly<{
    reason: string;
    contexts: readonly string[];
    payloadBytes?: number;
  }>,
): void {
  for (const contextName of event.contexts) {
    realtimeSyncRequiredCounter.add(1, {
      context: contextName,
      reason: event.reason,
    });
    if (event.payloadBytes !== undefined) {
      realtimePayloadBytes.record(event.payloadBytes, {
        context: contextName,
        event_kind: "sync.required",
      });
    }
  }
}

export function recordRealtimeWakeWaitEnded(
  event: Readonly<{
    result: string;
  }>,
): void {
  realtimeWakeCounter.add(1, {
    result: event.result,
  });
}

export function recordRealtimeWakeNotificationReceived(
  event: Readonly<{
    matchedWaiterCount: number;
  }>,
): void {
  realtimeWakeNotificationCounter.add(1, {
    matched: event.matchedWaiterCount > 0,
  });
}

export function recordRealtimeReadHub(
  event: Readonly<{
    action: "started" | "coalesced";
    topics: readonly string[];
  }>,
): void {
  realtimeReadHubCounter.add(1, {
    action: event.action,
    topic_count: event.topics.length,
  });
}

export function recordUcpOperationCompleted(
  event: Readonly<{
    transport: string;
    operation: string;
    status: string;
  }>,
): void {
  ucpOperationCounter.add(1, {
    transport: event.transport,
    operation: event.operation,
    status: event.status,
  });
}

export function recordMcpAuditRecord(
  event: Readonly<{
    outcome: string;
    method: string;
    toolName?: string | null;
    resourceUri?: string | null;
    auditEventName?: string | null;
    targetType?: string | null;
    reason?: string | null;
  }>,
): void {
  mcpAuditCounter.add(1, {
    outcome: event.outcome,
    method: event.method,
    tool: boundedMetricLabel(event.toolName ?? "none"),
    resource: event.resourceUri ? "present" : "none",
    audit_event: boundedMetricLabel(event.auditEventName ?? "none"),
    target_type: boundedMetricLabel(event.targetType ?? "none"),
    reason: normalizeReason(event.reason ?? "none"),
  });
}

export function recordSettlementOperationSignal(
  event: Readonly<{
    kind: string;
    providerName?: string | null;
    setupSurface?: string | null;
    safeCategory?: string | null;
    readinessStatus?: string | null;
  }>,
): void {
  settlementOperationCounter.add(1, {
    kind: event.kind,
    provider: event.providerName ?? "unknown",
    setup_surface: event.setupSurface ?? "none",
    safe_category: event.safeCategory ?? "none",
    readiness_status: event.readinessStatus ?? "unknown",
  });
}

export function checkoutObservabilityEventAttributes(event: CheckoutObservabilityEventSignal): Attributes {
  return {
    context: "checkout",
    event_name: boundedMetricLabel(event.eventName),
    telemetry_class: boundedMetricLabel(event.telemetryClass),
    alert_class: boundedMetricLabel(event.alertClass),
    entry_source: boundedMetricLabel(event.entrySource),
    actor_mode: boundedMetricLabel(event.actorMode),
    scenario_state: boundedMetricLabel(event.scenarioState),
    visible_state: boundedMetricLabel(event.visibleState),
    side_effect_status: boundedMetricLabel(event.sideEffectStatus),
    operator_signal_required: event.operatorSignalRequired === true ? "true" : "false",
    readiness_contract: boundedMetricLabel(event.readinessContract),
    readiness_snapshot_state: boundedMetricLabel(event.readinessSnapshotState),
    source_revision_state: boundedMetricLabel(event.sourceRevisionState),
    fresh_write_receipt_presence: boundedMetricLabel(event.freshWriteReceiptPresence),
    support_reference_present: event.supportReferencePresent === true ? "true" : "false",
    performance_budget_id: boundedMetricLabel(event.performanceBudgetId),
    provider_category: boundedMetricLabel(event.providerCategory),
    risk_category: boundedMetricLabel(event.riskCategory),
    downstream_status: boundedMetricLabel(event.downstreamStatus),
    capability_decision: boundedMetricLabel(event.capabilityDecision),
    fresh_state_scan_result: boundedMetricLabel(event.freshStateScanResult),
  };
}

export function recordCheckoutObservabilityEvent(event: CheckoutObservabilityEventSignal): void {
  checkoutObservabilityEventCounter.add(1, checkoutObservabilityEventAttributes(event));
}

export function postWriteConsistencyEventAttributes(event: PostWriteConsistencyEventSignal): Attributes {
  return {
    type: "post-write.consistency",
    context: boundedMetricLabel(event.boundedContextName),
    surface: boundedMetricLabel(event.surface),
    strategy: boundedMetricLabel(event.strategy),
    outcome: event.outcome,
    route_id: boundedRouteIdLabel(event.routeId),
    route_template: boundedRouteTemplateLabel(event.routeTemplate),
    correction_source: boundedMetricLabel(event.correctionSource),
    actor_mode: boundedMetricLabel(event.actorMode),
    recovery_action: boundedMetricLabel(event.recoveryAction),
    freshness_outcome: boundedMetricLabel(event.freshnessOutcome),
    source_context: boundedMetricLabel(event.sourceContextName),
    projection: boundedMetricLabel(event.projectionName),
    read_model_table: boundedMetricLabel(event.readModelTable),
    fallback_id: boundedMetricLabel(event.fallbackId),
    fallback_category: boundedMetricLabel(event.fallbackCategory),
  };
}

export function recordPostWriteConsistencyEvent(event: PostWriteConsistencyEventSignal): void {
  postWriteConsistencyEventCounter.add(1, postWriteConsistencyEventAttributes(event));
}

export function catalogIntegrationOptionQueryAttributes(event: CatalogIntegrationOptionQuerySignal): Attributes {
  return {
    context: "catalog",
    provider: boundedMetricLabel(event.providerKey),
    query_kind: boundedMetricLabel(event.queryKind),
    cache_status: boundedMetricLabel(event.cacheStatus),
    cache_source: boundedMetricLabel(event.cacheSource),
    result: event.result,
    degraded: event.degraded,
    cache_only: event.cacheOnly,
    force_refresh: event.forceRefresh,
  };
}

export function recordCatalogIntegrationOptionQuery(event: CatalogIntegrationOptionQuerySignal): void {
  catalogIntegrationOptionQueryCounter.add(1, catalogIntegrationOptionQueryAttributes(event));
}

export function catalogIntegrationJobAttributes(event: CatalogIntegrationJobSignal): Attributes {
  return {
    context: "catalog",
    operation: event.operation,
    job_kind: boundedMetricLabel(event.jobKind),
    result: boundedMetricLabel(event.result),
  };
}

export function recordCatalogIntegrationJob(event: CatalogIntegrationJobSignal): void {
  catalogIntegrationJobCounter.add(1, catalogIntegrationJobAttributes(event));
}

export function catalogControlPlaneEventAttributes(event: CatalogControlPlaneEventSignal): Attributes {
  return {
    context: "catalog",
    event: boundedMetricLabel(event.eventName),
    provider: boundedMetricLabel(event.providerKey),
    unit: boundedMetricLabel(event.unitKey),
    scope: boundedMetricLabel(event.scopeId),
    profile: boundedMetricLabel(event.profileRef),
    job_ref: boundedMetricLabel(event.jobRefState),
    observation_status: boundedMetricLabel(event.observationStatus),
    observation_count: boundedMetricLabel(event.observationCountBucket),
    promotion_result: boundedMetricLabel(event.promotionResult),
    promotion_count: boundedMetricLabel(event.promotionCountBucket),
    blocker_category: boundedMetricLabel(event.blockerCategory),
    detour_target: boundedMetricLabel(event.detourTarget),
    detour_outcome: boundedMetricLabel(event.detourOutcome),
    role_bucket: boundedMetricLabel(event.roleBucket),
    read_model_freshness: boundedMetricLabel(event.readModelFreshness),
  };
}

export function recordCatalogControlPlaneEvent(event: CatalogControlPlaneEventSignal): void {
  catalogControlPlaneEventCounter.add(1, catalogControlPlaneEventAttributes(event));
}

export function projectionFreshnessAuditMetricRecords(event: ProjectionFreshnessAuditSignal): Readonly<{
  evaluations: readonly ProjectionFreshnessEvaluationMetric[];
  pending: readonly ProjectionFreshnessPendingMetric[];
  wakeRequests: readonly ProjectionFreshnessWakeRequestMetric[];
  workSignalErrors: readonly ProjectionFreshnessWorkSignalErrorMetric[];
}> {
  const routePaths = event.routePaths.length > 0 ? event.routePaths : ["unmatched"];
  const targetContexts =
    event.dependencies.length > 0
      ? event.dependencies
      : event.targetContextNames.map((targetContextName) => ({
          targetContextName,
          projectionName: "none",
        }));
  const targetDependencies =
    targetContexts.length > 0 ? targetContexts : [{ targetContextName: "none", projectionName: "none" }];
  const sourceContexts = event.receiptSourceContextNames.length > 0 ? event.receiptSourceContextNames : ["none"];
  const receiptStatus = event.readAfterWriteHeaderPresent ? "present" : "missing";
  const targetHeaderStatus = event.readTargetContextHeaderPresent
    ? event.readTargetContextHeaderValid
      ? "present_valid"
      : "present_invalid"
    : "missing";
  const workSignalAttributes = {
    outcome: boundedMetricLabel(event.outcome),
    wait_mode: boundedMetricLabel(event.waitMode),
  };

  return {
    evaluations: routePaths.flatMap((routePath) =>
      targetDependencies.flatMap((dependency) =>
        sourceContexts.map((sourceContextName) => ({
          durationMs: Math.max(0, Math.round(event.durationMs)),
          attributes: {
            type: "read-after-write.freshness",
            outcome: boundedMetricLabel(event.outcome),
            method: boundedMetricLabel(event.method.toUpperCase()),
            mount_path: boundedRouteTemplateLabel(event.mountPath),
            route_path: boundedRouteTemplateLabel(routePath),
            target_context: boundedMetricLabel(dependency.targetContextName),
            projection: boundedMetricLabel(dependency.projectionName),
            source_context: boundedMetricLabel(sourceContextName),
            wait_mode: boundedMetricLabel(event.waitMode),
            receipt: receiptStatus,
            target_context_header: targetHeaderStatus,
            receipt_source_count: event.receiptSourceCount,
            receipt_event_count: event.receiptEventCount,
          },
        })),
      ),
    ),
    pending: routePaths.flatMap((routePath) =>
      event.pending.map((pending) => ({
        globalPositionLag: coerceMetricNumber(pending.globalPositionLag),
        attributes: {
          type: "read-after-write.freshness",
          outcome: boundedMetricLabel(event.outcome),
          method: boundedMetricLabel(event.method.toUpperCase()),
          mount_path: boundedRouteTemplateLabel(event.mountPath),
          route_path: boundedRouteTemplateLabel(routePath),
          target_context: boundedMetricLabel(pending.targetContextName),
          projection: boundedMetricLabel(pending.projectionName),
          source_context: boundedMetricLabel(pending.sourceContextName),
          wait_mode: boundedMetricLabel(event.waitMode),
          state: boundedMetricLabel(pending.state),
          last_error: pending.lastError === "present" ? "present" : "none",
        },
      })),
    ),
    wakeRequests:
      event.wakeRequestCount > 0
        ? [{ wakeRequestCount: event.wakeRequestCount, attributes: workSignalAttributes }]
        : [],
    workSignalErrors: event.workSignalError === "present" ? [{ attributes: workSignalAttributes }] : [],
  };
}

export function recordProjectionFreshnessAudit(event: ProjectionFreshnessAuditSignal): void {
  const records = projectionFreshnessAuditMetricRecords(event);
  for (const evaluation of records.evaluations) {
    projectionFreshnessEvaluationCounter.add(1, evaluation.attributes);
    projectionFreshnessWaitDuration.record(evaluation.durationMs, evaluation.attributes);
  }
  for (const pending of records.pending) {
    projectionFreshnessPendingCounter.add(1, pending.attributes);
    projectionFreshnessPendingLag.record(pending.globalPositionLag, pending.attributes);
  }
  for (const wakeRequest of records.wakeRequests) {
    projectionFreshnessWakeRequestCounter.add(wakeRequest.wakeRequestCount, wakeRequest.attributes);
  }
  for (const workSignalError of records.workSignalErrors) {
    projectionFreshnessWorkSignalErrorCounter.add(1, workSignalError.attributes);
  }
}

export function projectionFreshnessWakeEnqueueMetricRecord(
  event: ProjectionFreshnessWakeEnqueueSignal,
): ProjectionFreshnessWakeEnqueueMetric {
  return {
    durationMs: Math.max(0, Math.round(event.durationMs)),
    attributes: {
      outcome: boundedMetricLabel(event.outcome),
      priority_lane: boundedMetricLabel(event.priorityLane),
      source_context: boundedMetricLabel(event.sourceContextName),
      target_context: boundedMetricLabel(event.targetContextName),
      projection: boundedMetricLabel(event.projectionName),
      mount_path: boundedRouteTemplateLabel(event.mountPath),
      route_path: boundedRouteTemplateLabel(event.routePath),
      request_count: Math.max(0, Math.floor(event.requestCount)),
      enqueued_count: Math.max(0, Math.floor(event.enqueuedCount)),
    },
  };
}

export function recordProjectionFreshnessWakeEnqueue(event: ProjectionFreshnessWakeEnqueueSignal): void {
  const record = projectionFreshnessWakeEnqueueMetricRecord(event);
  projectionFreshnessWakeEnqueueDuration.record(record.durationMs, record.attributes);
}

export function recordProjectionWakeNotificationEmitted(event: ProjectionWakeNotificationEmittedSignal): void {
  const sourceContext = boundedMetricLabel(event.sourceContextName);
  projectionWakeNotificationCounter.add(1, {
    source_context: sourceContext,
    stream_category: boundedMetricLabel(event.streamCategory),
  });
  projectionWakeNotificationPayloadBytes.record(event.payloadBytes, {
    source_context: sourceContext,
  });
}

export function recordProjectionWakeRelayCatchUp(event: ProjectionWakeRelayCatchUpSignal): void {
  const attributes = {
    source_context: boundedMetricLabel(event.sourceContextName),
    reason: boundedMetricLabel(event.reason),
  };
  projectionWakeRelayCatchUpCounter.add(1, attributes);
  if (Number.isFinite(event.durationMs)) {
    projectionWakeRelayCatchUpDuration.record(Math.max(0, event.durationMs), attributes);
  }
  if (event.eventCount > 0) {
    projectionWakeRelayCatchUpEventsCounter.add(event.eventCount, attributes);
  }
}

export function recordProjectionWakeRelayFanOut(event: ProjectionWakeRelayFanOutSignal): void {
  const sourceContext = boundedMetricLabel(event.sourceContextName);
  const priorityLane = boundedMetricLabel(event.priorityLane);
  const routingMode = boundedMetricLabel(event.routingMode);
  projectionWakeRelayFanOutCounter.add(1, {
    source_context: sourceContext,
    status: boundedMetricLabel(event.status),
    reason: boundedMetricLabel(event.reason),
    priority_lane: priorityLane,
    routing_mode: routingMode,
  });
  if (event.enqueuedCount > 0) {
    projectionWakeRelayFanOutIntentsCounter.add(event.enqueuedCount, {
      source_context: sourceContext,
      priority_lane: priorityLane,
      routing_mode: routingMode,
    });
  }
  if (
    typeof event.notificationAgeMs === "number" &&
    Number.isFinite(event.notificationAgeMs) &&
    event.notificationAgeMs >= 0
  ) {
    projectionWakeNotificationAge.record(event.notificationAgeMs, {
      source_context: sourceContext,
    });
  }
}

export function projectionWakeIntentEnqueueOutcomeMetricRecord(
  event: ProjectionWakeIntentEnqueueOutcomeSignal,
): ProjectionWakeIntentEnqueueOutcomeMetric {
  return {
    attributes: {
      outcome: boundedMetricLabel(event.outcome),
      source_context: boundedMetricLabel(event.sourceContextName),
      target_context: boundedMetricLabel(event.targetContextName),
      projection: boundedMetricLabel(event.projectionName),
      priority_lane: boundedMetricLabel(event.priorityLane),
      origin: boundedMetricLabel(event.origin),
      routing_mode: boundedMetricLabel(event.routingMode),
    },
  };
}

export function recordProjectionWakeIntentEnqueueOutcome(event: ProjectionWakeIntentEnqueueOutcomeSignal): void {
  const record = projectionWakeIntentEnqueueOutcomeMetricRecord(event);
  projectionWakeIntentEnqueueOutcomeCounter.add(1, record.attributes);
}

export function projectionInterestIndexLookupMetricRecord(
  event: ProjectionInterestIndexLookupSignal,
): Readonly<{ attributes: Attributes; durationMs: number }> {
  return {
    durationMs: Math.max(0, Math.round(event.durationMs)),
    attributes: {
      source_context: boundedMetricLabel(event.sourceContextName),
      target_context: boundedMetricLabel(event.targetContextName),
      projection: boundedMetricLabel(event.projectionName),
      priority_lane: boundedMetricLabel(event.priorityLane),
      outcome: boundedMetricLabel(event.outcome),
    },
  };
}

export function recordProjectionInterestIndexLookup(event: ProjectionInterestIndexLookupSignal): void {
  const record = projectionInterestIndexLookupMetricRecord(event);
  projectionInterestIndexLookupCounter.add(1, record.attributes);
  projectionInterestIndexLookupDuration.record(record.durationMs, record.attributes);
}

export function recordProjectionWakeIntentOutcome(event: ProjectionWakeIntentOutcomeSignal): void {
  const outcome = boundedMetricLabel(event.outcome);
  const priorityLane = boundedMetricLabel(event.priorityLane);
  const origin = boundedMetricLabel(event.origin);

  // Attempts-exhausted is a supplemental alerting marker emitted alongside
  // the same pass's retry outcome; keep it off the intent totals and the
  // queue-age histogram so dispositions are counted exactly once.
  if (event.outcome === "attempts-exhausted") {
    projectionWakeIntentAttemptsExhaustedCounter.add(1, {
      priority_lane: priorityLane,
      origin,
      target_context: boundedMetricLabel(event.targetContextName),
      projection: boundedMetricLabel(event.projectionName),
    });
    return;
  }

  projectionWakeIntentCounter.add(1, {
    outcome,
    priority_lane: priorityLane,
    origin,
    target_context: boundedMetricLabel(event.targetContextName),
    projection: boundedMetricLabel(event.projectionName),
    requeued: event.requeued === true,
  });
  projectionWakeIntentQueueAge.record(Math.max(0, event.queueAgeMs), {
    priority_lane: priorityLane,
    origin,
    outcome,
  });
  if (
    typeof event.processingDurationMs === "number" &&
    Number.isFinite(event.processingDurationMs) &&
    event.processingDurationMs >= 0
  ) {
    projectionWakeIntentProcessingDuration.record(event.processingDurationMs, {
      priority_lane: priorityLane,
      outcome,
    });
  }
}

export function recordUcpSignedWriteRejected(
  event: Readonly<{
    transport: string;
    operation: string;
    reason: string;
  }>,
): void {
  ucpSignedWriteRejectedCounter.add(1, {
    transport: event.transport,
    operation: event.operation,
    reason: normalizeReason(event.reason),
  });
}

export function recordUcpSignatureVerificationFailed(
  event: Readonly<{
    transport: string;
    operation: string;
    reason: string;
  }>,
): void {
  ucpSignatureVerificationFailedCounter.add(1, {
    transport: event.transport,
    operation: event.operation,
    reason: normalizeReason(event.reason),
  });
}

export function recordUcpIdempotencyReplayed(
  event: Readonly<{
    transport: string;
    operation: string;
  }>,
): void {
  ucpIdempotencyCounter.add(1, {
    transport: event.transport,
    operation: event.operation,
    result: "replayed",
  });
}

export function recordUcpIdempotencyConflict(
  event: Readonly<{
    transport: string;
    operation: string;
  }>,
): void {
  ucpIdempotencyCounter.add(1, {
    transport: event.transport,
    operation: event.operation,
    result: "conflict",
  });
}

export function publicPresenceWaitlistAnalyticsAttributes(event: PublicPresenceWaitlistAnalyticsSignal): Attributes {
  return {
    context: "public-presence",
    event: boundedMetricLabel(event.event),
    section: boundedMetricLabel(event.section),
    target: boundedMetricLabel(event.target),
    field: boundedMetricLabel(event.field),
    role: boundedMetricLabel(event.role),
    interest: boundedMetricLabel(event.interest),
    variant: boundedMetricLabel(event.variant),
    status: boundedMetricLabel(event.status),
  };
}

export function recordPublicPresenceWaitlistAnalytics(event: PublicPresenceWaitlistAnalyticsSignal): void {
  publicPresenceWaitlistEventCounter.add(1, publicPresenceWaitlistAnalyticsAttributes(event));
}

export function itemDetailRailAnalyticsAttributes(event: ItemDetailRailAnalyticsSignal): Attributes {
  return {
    context: "marketplace",
    event: boundedMetricLabel(event.event),
    intent: boundedMetricLabel(event.intent),
    workflow: boundedMetricLabel(event.workflow),
    selection: boundedMetricLabel(event.selection),
    topic: boundedMetricLabel(event.topic),
    outcome: boundedMetricLabel(event.outcome),
    gate: boundedMetricLabel(event.gate),
    viewer: boundedMetricLabel(event.viewer),
    surface: boundedMetricLabel(event.surface),
  };
}

export function recordItemDetailRailAnalytics(event: ItemDetailRailAnalyticsSignal): void {
  itemDetailRailEventCounter.add(1, itemDetailRailAnalyticsAttributes(event));
}

export function sanitizeLogFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SENSITIVE_FIELD_RE.test(key) ? "[redacted]" : sanitizeValue(value),
    ]),
  );
}

async function observeOperation<T>(
  options: Readonly<{
    name: string;
    attributes: Attributes;
    counter: Counter;
    duration: Histogram;
    work: () => Promise<T>;
  }>,
): Promise<T> {
  const startedAt = performance.now();
  return tracer.startActiveSpan(options.name, { attributes: options.attributes }, async (span) => {
    try {
      const result = await options.work();
      options.counter.add(1, { ...options.attributes, status: "ok" });
      return result;
    } catch (error) {
      span.recordException(normalizeError(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      options.counter.add(1, { ...options.attributes, status: "error" });
      throw error;
    } finally {
      options.duration.record(performance.now() - startedAt, options.attributes);
      span.end();
    }
  });
}

const headersGetter = {
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function parsePositiveInteger(value: string | undefined, defaultValue: number, maxValue: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(parsed, maxValue);
}

function parseNonNegativeInteger(value: string | undefined, defaultValue: number, maxValue: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }

  return Math.min(parsed, maxValue);
}

function parseResourceAttributes(value: string | undefined): Readonly<Record<string, string>> {
  if (!value?.trim()) {
    return {};
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex <= 0) {
          return [];
        }
        return [[entry.slice(0, separatorIndex).trim(), entry.slice(separatorIndex + 1).trim()]];
      }),
  );
}

export function parseOtlpHeaders(value: string | undefined): Readonly<Record<string, string>> {
  if (!value?.trim()) {
    return {};
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex <= 0) {
          return [];
        }

        const name = entry.slice(0, separatorIndex).trim();
        if (!HEADER_NAME_RE.test(name)) {
          return [];
        }

        return [[name, decodeOtlpHeaderValue(entry.slice(separatorIndex + 1).trim())]];
      }),
  );
}

function decodeOtlpHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimTrailingSlash(value: string | undefined): string {
  return (value ?? DEFAULT_OTLP_ENDPOINT).replace(/\/+$/, "");
}

function applyOtelEnvironmentDefaults(config: ObservabilityConfig): void {
  process.env.OTEL_TRACES_SAMPLER ??= config.tracesSampler;
  if (config.tracesSamplerArg) {
    process.env.OTEL_TRACES_SAMPLER_ARG ??= config.tracesSamplerArg;
  }
}

function writeLogFile(logFilePath: string | undefined, line: string): void {
  if (!logFilePath) {
    return;
  }

  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, `${line}\n`, "utf8");
  } catch {
    // Logging must never disrupt request handling.
  }
}

type StructuredLogExportTask = Readonly<{
  entry: LogFields;
  timestamp: string;
}>;

function createStructuredLogExporter(config: ObservabilityConfig): (entry: LogFields) => void {
  if (!config.enabled || !config.otlpEndpoint || typeof fetch !== "function") {
    return () => undefined;
  }

  let inFlight = 0;
  const queue: StructuredLogExportTask[] = [];
  const run = (task: StructuredLogExportTask) => {
    inFlight += 1;
    void sendStructuredLog(config, task.entry, task.timestamp).finally(() => {
      inFlight -= 1;
      const next = queue.shift();
      if (next) {
        run(next);
      }
    });
  };

  return (entry) => {
    const task: StructuredLogExportTask = {
      entry,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
    };

    if (inFlight < config.logExportMaxInFlight) {
      run(task);
      return;
    }

    if (queue.length < config.logExportQueueSize) {
      queue.push(task);
    }
  };
}

async function warnIfCollectorUnavailable(config: ObservabilityConfig, logger: Logger): Promise<void> {
  if (!config.otlpEndpoint || typeof fetch !== "function") {
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      await fetch(config.otlpEndpoint, {
        method: "GET",
        headers: config.otlpHeaders,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    logger.warn("OpenTelemetry Collector is unavailable; telemetry export is best effort.", {
      type: "observability.collector_unavailable",
      otlpEndpoint: config.otlpEndpoint,
      error,
    });
  }
}

async function sendStructuredLog(config: ObservabilityConfig, entry: LogFields, timestamp: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    await fetch(`${trimTrailingSlash(config.otlpEndpoint)}/v1/logs`, {
      method: "POST",
      headers: {
        ...config.otlpHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(otlpLogPayload(config, entry, timestamp)),
      signal: controller.signal,
    });
  } catch {
    // Structured logging is best effort; application work must not wait on telemetry.
  } finally {
    clearTimeout(timeout);
  }
}

function otlpLogPayload(config: ObservabilityConfig, entry: LogFields, timestamp: string) {
  const level = typeof entry.level === "string" ? entry.level : "info";
  const timeUnixNano = isoToUnixNano(timestamp);

  return {
    resourceLogs: [
      {
        resource: {
          attributes: objectToOtlpAttributes({
            "service.name": config.serviceName,
            "deployment.environment": config.deploymentEnvironment,
            ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
            ...config.resourceAttributes,
          }),
        },
        scopeLogs: [
          {
            scope: {
              name: "@chase-sets/observability",
            },
            logRecords: [
              {
                timeUnixNano,
                observedTimeUnixNano: timeUnixNano,
                severityNumber: otlpSeverityNumber(level),
                severityText: level.toUpperCase(),
                body: {
                  stringValue: JSON.stringify(entry),
                },
                traceId: typeof entry.traceId === "string" ? entry.traceId : undefined,
                spanId: typeof entry.spanId === "string" ? entry.spanId : undefined,
                attributes: objectToOtlpAttributes(entry),
              },
            ],
          },
        ],
      },
    ],
  };
}

function isoToUnixNano(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return `${BigInt(Date.now()) * 1000000n}`;
  }

  return `${BigInt(millis) * 1000000n}`;
}

function otlpSeverityNumber(level: string): number {
  switch (level) {
    case "debug":
      return 5;
    case "warn":
      return 13;
    case "error":
      return 17;
    default:
      return 9;
  }
}

function objectToOtlpAttributes(fields: LogFields): ReadonlyArray<{
  key: string;
  value: ReturnType<typeof unknownToOtlpValue>;
}> {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value: unknownToOtlpValue(value),
    }));
}

function unknownToOtlpValue(value: unknown) {
  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: `${value}` } : { doubleValue: value };
  }

  return { stringValue: JSON.stringify(value) };
}

function normalizeRouteTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => {
      if (!part) {
        return part;
      }
      if (/^[a-z]{2,12}_[A-Za-z0-9]+$/.test(part) || /^[0-9A-Fa-f-]{12,}$/.test(part)) {
        return ":id";
      }
      return part;
    })
    .join("/");
}

function toStatusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function normalizeReason(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

function boundedMetricLabel(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) {
    return "none";
  }

  const normalized = text.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
  return normalized || "other";
}

function boundedRouteTemplateLabel(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) {
    return "none";
  }

  const template = text
    .split("/")
    .map((part) => {
      if (!part || part.startsWith(":")) {
        return part;
      }
      if (/^[a-z]{2,12}_[A-Za-z0-9]+$/.test(part) || /^[0-9A-Fa-f-]{12,}$/.test(part)) {
        return ":id";
      }
      return part;
    })
    .join("/");
  const normalized = template.replace(/[^a-zA-Z0-9_./:-]+/g, "_").slice(0, 160);
  return normalized || "other";
}

function boundedRouteIdLabel(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) {
    return "none";
  }

  return boundedMetricLabel(text.replace(/\b(?:account|acct|cart|crt|chk|usr|user)_[0-9A-Za-z_.:-]+\b/g, ":id"));
}

function coerceMetricNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorToFields(error: unknown): LogFields {
  const normalized = normalizeError(error);
  return {
    name: normalized.name,
    message: normalized.message,
  };
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return errorToFields(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (typeof value === "object" && value !== null) {
    return sanitizeLogFields(value as LogFields);
  }

  return value;
}
