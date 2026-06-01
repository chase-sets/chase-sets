import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SpanKind, SpanStatusCode, context, metrics, propagation, trace, type Attributes } from "@opentelemetry/api";
import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type ObservabilityConfig = Readonly<{
  enabled: boolean;
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment: string;
  otlpEndpoint?: string;
  tracesSampler: string;
  tracesSamplerArg?: string;
  logFilePath?: string;
  logLevel: LogLevel;
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
const SENSITIVE_FIELD_RE = /(authorization|cookie|token|secret|password|email|address|card|key|apiKey)/i;
const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} satisfies Record<LogLevel, number>;

const tracer = trace.getTracer("@chase-sets/observability");
const meter = metrics.getMeter("@chase-sets/observability");
const requestCounter = meter.createCounter("chase_sets_http_server_requests_total");
const requestDuration = meter.createHistogram("chase_sets_http_server_request_duration_ms", {
  unit: "ms",
});
const eventStoreCounter = meter.createCounter("chase_sets_event_store_operations_total");
const eventStoreDuration = meter.createHistogram("chase_sets_event_store_operation_duration_ms", {
  unit: "ms",
});
const projectorCounter = meter.createCounter("chase_sets_projection_runs_total");
const projectorDuration = meter.createHistogram("chase_sets_projection_run_duration_ms", {
  unit: "ms",
});
const workerCounter = meter.createCounter("chase_sets_worker_runs_total");
const workerDuration = meter.createHistogram("chase_sets_worker_run_duration_ms", {
  unit: "ms",
});
const realtimeConnectionCounter = meter.createCounter("chase_sets_realtime_connections_total");
const realtimeActiveConnections = meter.createUpDownCounter("chase_sets_realtime_active_connections");
const realtimeStreamDuration = meter.createHistogram("chase_sets_realtime_stream_duration_ms", {
  unit: "ms",
});
const realtimeAuthorizationRejectedCounter = meter.createCounter("chase_sets_realtime_authorization_rejected_total");
const realtimeBatchSize = meter.createHistogram("chase_sets_realtime_batch_messages", {
  unit: "{message}",
});
const realtimeMessageCounter = meter.createCounter("chase_sets_realtime_messages_total");
const realtimePayloadBytes = meter.createHistogram("chase_sets_realtime_payload_bytes", {
  unit: "By",
});
const realtimeSyncRequiredCounter = meter.createCounter("chase_sets_realtime_sync_required_total");
const realtimeWakeCounter = meter.createCounter("chase_sets_realtime_wake_waits_total");
const realtimeWakeNotificationCounter = meter.createCounter("chase_sets_realtime_wake_notifications_total");
const realtimeReadHubCounter = meter.createCounter("chase_sets_realtime_read_hub_total");
const realtimeTopicLag = meter.createHistogram("chase_sets_realtime_topic_lag", {
  unit: "{message}",
});
const ucpOperationCounter = meter.createCounter("chase_sets_ucp_operations_total");
const ucpSignedWriteRejectedCounter = meter.createCounter("chase_sets_ucp_signed_write_rejected_total");
const ucpSignatureVerificationFailedCounter = meter.createCounter("chase_sets_ucp_signature_verification_failed_total");
const ucpIdempotencyCounter = meter.createCounter("chase_sets_ucp_idempotency_total");
const publicPresenceWaitlistEventCounter = meter.createCounter("chase_sets_public_presence_waitlist_events_total");
const settlementOperationCounter = meter.createCounter("chase_sets_settlement_operations_total");

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

let runtime: ObservabilityRuntime | null = null;

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
    tracesSampler: nonEmpty(env.OTEL_TRACES_SAMPLER) ?? "parentbased_traceidratio",
    tracesSamplerArg: nonEmpty(env.OTEL_TRACES_SAMPLER_ARG) ?? (env.NODE_ENV === "production" ? "0.1" : "1.0"),
    logFilePath: nonEmpty(env.LOG_FILE_PATH),
    logLevel: parseLogLevel(env.LOG_LEVEL),
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
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${trimTrailingSlash(config.otlpEndpoint)}/v1/metrics`,
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

export function getObservabilityRuntime(): ObservabilityRuntime {
  return runtime ?? startObservability();
}

export function createLogger(config = loadObservabilityConfig()): Logger {
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
    counter: ReturnType<typeof meter.createCounter>;
    duration: ReturnType<typeof meter.createHistogram>;
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

function normalizeRouteTemplate(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => {
      if (!part) {
        return part;
      }
      if (/^[a-z]{2,5}_[A-Za-z0-9]+$/.test(part) || /^[0-9A-Fa-f-]{12,}$/.test(part)) {
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
