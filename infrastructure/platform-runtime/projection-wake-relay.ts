import {
  assertPostgresEventStoreWakeNotificationChannel,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  EVENT_STORE_WAKE_NOTIFICATION_KIND,
  EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION,
  EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION,
  type EventStoreWakeNotificationEnvelope,
  type EventStoreWakeNotificationPayload,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  parseGlobalPosition,
  ZERO_GLOBAL_POSITION,
  type GlobalPosition,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";

import {
  createProjectionWakeIntentInputs,
  ProjectionInterestIndexStaleError,
  type ProjectionInterestIndex,
} from "./projection-interest-index";
import type { PlatformControlPlane, PlatformLease, ProjectionWakeRelayCursorRecord } from "./control-plane";
import { listSourceContextWakeRelayConfigs, type SourceContextWakeRelayConfig } from "./source-context-wake-registry";
import type {
  EnqueueProjectionWakeIntentInput,
  JsonRecord,
  PostgresWorkSignalStore,
  ProjectionWakeIntentRecord,
  WorkSignalPriorityLane,
} from "./work-signal-store";

const PROJECTION_WAKE_RELAY_FAN_OUT_SCHEMA_VERSION = 1;
const PROJECTION_WAKE_RELAY_FAN_OUT_METADATA_VERSION = 1;
export const PROJECTION_WAKE_RELAY_ACTIVE_LEASE_NAME = "projection-wake-relay:active";
const DEFAULT_PROJECTION_WAKE_RELAY_CATCH_UP_BATCH_SIZE = 100;
const DEFAULT_PROJECTION_WAKE_RELAY_RECONNECT_BACKOFF_MS = 1_000;

export type ProjectionWakeRelayFanOutStatus = "enqueued" | "skipped";
export type ProjectionWakeRelaySkippedReason = "source-disabled" | "no-interests";
export type ProjectionWakeRelayCatchUpReason = "startup" | "notification" | "reconnect";
export type ProjectionWakeRelayFanOutFailureReason =
  | "invalid-notification"
  | "stale-interest-index"
  | "enqueue-failed"
  | "unexpected";

export type ProjectionWakeRelayWorkSignalStore = Pick<PostgresWorkSignalStore, "enqueueProjectionWakeIntent">;
export type ProjectionWakeRelayControlPlane = Pick<
  PlatformControlPlane,
  "acquireLease" | "renewLease" | "releaseLease" | "getProjectionWakeRelayCursor" | "advanceProjectionWakeRelayCursor"
>;

type ProjectionWakeRelayListenerClient = PgPoolClient &
  Readonly<{
    on?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
    off?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
    removeListener?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
  }>;

export type ProjectionWakeRelaySourceRuntime = Readonly<{
  sourceContextName: string;
  eventStore: Pick<EventStore, "readAll">;
  listenerPool?: Pick<PgTransactionalPool, "connect">;
  streamPrefixes?: readonly string[];
}>;

export type ProjectionWakeRelayActiveSessionInput = Readonly<{
  workerId: string;
  controlPlane: ProjectionWakeRelayControlPlane;
  projectionInterestIndex: ProjectionInterestIndex;
  workSignalStore: ProjectionWakeRelayWorkSignalStore;
  sources: readonly ProjectionWakeRelaySourceRuntime[];
  relayConfigs?: readonly SourceContextWakeRelayConfig[];
  leaseName?: string;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  catchUpBatchSize?: number;
  reconnectBackoffMs?: number;
  signal?: AbortSignal;
  observer?: ProjectionWakeRelayRuntimeObserver;
  now?: () => Date;
}>;

export type ProjectionWakeRelayActiveSessionStatus = "stopped" | "lease-missed" | "lease-lost" | "no-enabled-sources";

export type ProjectionWakeRelayActiveSessionResult = Readonly<{
  status: ProjectionWakeRelayActiveSessionStatus;
  leaseName: string;
  sourceContextNames: readonly string[];
  caughtUpEventCount: number;
  cursorAdvanceCount: number;
}>;

export type ProjectionWakeRelayFanOutInput = Readonly<{
  notification: unknown;
  projectionInterestIndex: ProjectionInterestIndex;
  workSignalStore: ProjectionWakeRelayWorkSignalStore;
  relayConfigs?: readonly SourceContextWakeRelayConfig[];
  metadata?: JsonRecord;
  observer?: ProjectionWakeRelayFanOutObserver;
}>;

export type ProjectionWakeRelayFanOutResult = Readonly<{
  status: ProjectionWakeRelayFanOutStatus;
  skippedReason: ProjectionWakeRelaySkippedReason | null;
  sourceContextName: string;
  streamCategory: string;
  eventTypes: readonly string[];
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  requiredCursor: string;
  priorityLane: WorkSignalPriorityLane | null;
  projectionInterestIndexVersion: string;
  intentCount: number;
  enqueuedCount: number;
  enqueuedWakeIntentIds: readonly string[];
  records: readonly ProjectionWakeIntentRecord[];
}>;

export type ProjectionWakeRelayFanOutObserver = Readonly<{
  notificationRejected?: (event: ProjectionWakeRelayNotificationRejectedEvent) => void;
  sourceSkipped?: (event: ProjectionWakeRelaySourceSkippedEvent) => void;
  fanOutSkipped?: (event: ProjectionWakeRelayFanOutSkippedEvent) => void;
  fanOutSucceeded?: (event: ProjectionWakeRelayFanOutSucceededEvent) => void;
  fanOutFailed?: (event: ProjectionWakeRelayFanOutFailedEvent) => void;
}>;

export type ProjectionWakeRelayRuntimeObserver = ProjectionWakeRelayFanOutObserver &
  Readonly<{
    sessionSkipped?: (event: ProjectionWakeRelaySessionSkippedEvent) => void;
    leaseAcquired?: (event: ProjectionWakeRelayLeaseEvent) => void;
    leaseMissed?: (event: ProjectionWakeRelayLeaseEvent) => void;
    leaseLost?: (event: ProjectionWakeRelayLeaseEvent & Readonly<{ error?: unknown }>) => void;
    sourceCatchUpStarted?: (event: ProjectionWakeRelaySourceCatchUpStartedEvent) => void;
    sourceCatchUpCompleted?: (event: ProjectionWakeRelaySourceCatchUpCompletedEvent) => void;
    sourceCatchUpFailed?: (event: ProjectionWakeRelaySourceCatchUpFailedEvent) => void;
    cursorAdvanced?: (event: ProjectionWakeRelayCursorAdvancedEvent) => void;
    listenerConnected?: (event: ProjectionWakeRelayListenerEvent) => void;
    listenerUnavailable?: (event: ProjectionWakeRelayListenerEvent & Readonly<{ error: unknown }>) => void;
    listenerDisconnected?: (event: ProjectionWakeRelayListenerEvent & Readonly<{ error?: unknown }>) => void;
    notificationReceived?: (event: ProjectionWakeRelayNotificationReceivedEvent) => void;
  }>;

export type ProjectionWakeRelaySessionSkippedEvent = Readonly<{
  leaseName: string;
  reason: "no-enabled-sources";
  configuredSourceCount: number;
  matchedSourceCount: number;
}>;

export type ProjectionWakeRelayLeaseEvent = Readonly<{
  leaseName: string;
  workerId: string;
  ownerId?: string;
  fencingToken?: string;
}>;

export type ProjectionWakeRelaySourceCatchUpStartedEvent = Readonly<{
  sourceContextName: string;
  reason: ProjectionWakeRelayCatchUpReason;
  afterGlobalPosition: string;
}>;

export type ProjectionWakeRelaySourceCatchUpCompletedEvent = Readonly<{
  sourceContextName: string;
  reason: ProjectionWakeRelayCatchUpReason;
  eventCount: number;
  cursorAdvanceCount: number;
  lastFanOutPosition: string | null;
  durationMs: number;
}>;

export type ProjectionWakeRelaySourceCatchUpFailedEvent = Readonly<{
  sourceContextName: string;
  reason: ProjectionWakeRelayCatchUpReason;
  error: unknown;
}>;

export type ProjectionWakeRelayCursorAdvancedEvent = Readonly<{
  sourceContextName: string;
  reason: ProjectionWakeRelayCatchUpReason;
  lastFanOutPosition: string;
  lastRequiredCursor: string;
  ownerId: string;
  fencingToken: string;
}>;

export type ProjectionWakeRelayListenerEvent = Readonly<{
  sourceContextName: string;
  channel: string;
}>;

export type ProjectionWakeRelayNotificationReceivedEvent = ProjectionWakeRelayListenerEvent &
  Readonly<{
    payloadBytes: number;
  }>;

export type ProjectionWakeRelayNotificationRejectedEvent = Readonly<{
  reason: string;
  error: unknown;
}>;

export type ProjectionWakeRelaySourceSkippedEvent = Readonly<{
  sourceContextName: string;
  streamCategory: string;
  lastGlobalPosition: string;
  reason: "source-disabled";
  relayFanOutEnabled: boolean;
  rolloutState: SourceContextWakeRelayConfig["rolloutState"] | null;
}>;

export type ProjectionWakeRelayFanOutSkippedEvent = Readonly<{
  sourceContextName: string;
  streamCategory: string;
  lastGlobalPosition: string;
  requiredCursor: string;
  reason: "no-interests";
  projectionInterestIndexVersion: string;
}>;

export type ProjectionWakeRelayFanOutSucceededEvent = Readonly<{
  sourceContextName: string;
  streamCategory: string;
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  requiredCursor: string;
  priorityLane: WorkSignalPriorityLane;
  projectionInterestIndexVersion: string;
  intentCount: number;
  enqueuedCount: number;
  enqueuedWakeIntentIds: readonly string[];
  notificationAgeMs: number | null;
}>;

export type ProjectionWakeRelayFanOutFailedEvent = Readonly<{
  sourceContextName: string | null;
  streamCategory: string | null;
  lastGlobalPosition: string | null;
  reason: ProjectionWakeRelayFanOutFailureReason;
  intentCount: number;
  enqueuedCount: number;
  error: unknown;
}>;

export class ProjectionWakeRelayNotificationRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string, options: { cause?: unknown } = {}) {
    super(`Projection wake relay rejected event-store wake notification: ${reason}.`, options);
    this.name = "ProjectionWakeRelayNotificationRejectedError";
    this.reason = reason;
  }
}

export async function runProjectionWakeRelayActiveSession(
  input: ProjectionWakeRelayActiveSessionInput,
): Promise<ProjectionWakeRelayActiveSessionResult> {
  const leaseName = input.leaseName ?? PROJECTION_WAKE_RELAY_ACTIVE_LEASE_NAME;
  const relayConfigs = input.relayConfigs ?? listSourceContextWakeRelayConfigs();
  const activeSources = selectActiveRelaySources(input.sources, relayConfigs);

  if (activeSources.length === 0) {
    input.observer?.sessionSkipped?.({
      leaseName,
      reason: "no-enabled-sources",
      configuredSourceCount: relayConfigs.filter((config) => config.relayFanOutEnabled).length,
      matchedSourceCount: 0,
    });
    return {
      status: "no-enabled-sources",
      leaseName,
      sourceContextNames: [],
      caughtUpEventCount: 0,
      cursorAdvanceCount: 0,
    };
  }

  const lease = await input.controlPlane.acquireLease({
    leaseName,
    ownerId: input.workerId,
    ttlMs: input.leaseTtlMs,
    metadata: {
      kind: "projection-wake-relay",
      sourceContextNames: activeSources.map((source) => source.source.sourceContextName),
    },
  });

  if (!lease) {
    input.observer?.leaseMissed?.({ leaseName, workerId: input.workerId });
    return {
      status: "lease-missed",
      leaseName,
      sourceContextNames: activeSources.map((source) => source.source.sourceContextName),
      caughtUpEventCount: 0,
      cursorAdvanceCount: 0,
    };
  }

  input.observer?.leaseAcquired?.({
    leaseName,
    workerId: input.workerId,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  });

  const abortController = new AbortController();
  const abortFromInput = () => abortController.abort();
  if (input.signal?.aborted) {
    abortController.abort();
  } else {
    input.signal?.addEventListener("abort", abortFromInput, { once: true });
  }

  let leaseActive = true;
  let caughtUpEventCount = 0;
  let cursorAdvanceCount = 0;
  const sourceStates = activeSources.map((activeSource) =>
    createRelaySourceState(input, activeSource.source, activeSource.config, lease, abortController.signal, (result) => {
      caughtUpEventCount += result.eventCount;
      cursorAdvanceCount += result.cursorAdvanceCount;
    }),
  );

  const renewalTimer = setInterval(
    () => {
      void input.controlPlane
        .renewLease(lease, input.leaseTtlMs)
        .then((renewed) => {
          leaseActive = leaseActive && renewed;
          if (!renewed) {
            input.observer?.leaseLost?.({
              leaseName,
              workerId: input.workerId,
              ownerId: lease.ownerId,
              fencingToken: lease.fencingToken,
            });
            abortController.abort();
          }
        })
        .catch((error: unknown) => {
          leaseActive = false;
          input.observer?.leaseLost?.({
            leaseName,
            workerId: input.workerId,
            ownerId: lease.ownerId,
            fencingToken: lease.fencingToken,
            error,
          });
          abortController.abort();
        });
    },
    Math.max(1_000, Math.min(input.leaseRenewIntervalMs, Math.floor(input.leaseTtlMs / 3))),
  );
  renewalTimer.unref?.();

  try {
    await Promise.all(sourceStates.map((state) => connectSourceListener(state)));
    await Promise.all(sourceStates.map((state) => enqueueSourceCatchUp(state, "startup")));
    await waitForProjectionWakeRelayAbort(abortController.signal);
    await Promise.allSettled(sourceStates.map((state) => state.processing));

    return {
      status: leaseActive ? "stopped" : "lease-lost",
      leaseName,
      sourceContextNames: sourceStates.map((state) => state.source.sourceContextName),
      caughtUpEventCount,
      cursorAdvanceCount,
    };
  } finally {
    input.signal?.removeEventListener("abort", abortFromInput);
    clearInterval(renewalTimer);
    abortController.abort();
    await Promise.allSettled(sourceStates.map((state) => stopSourceListener(state)));
    await input.controlPlane.releaseLease(lease);
  }
}

export const DEFAULT_PROJECTION_WAKE_RELAY_STANDBY_RETRY_MS = 15_000;
export const DEFAULT_PROJECTION_WAKE_RELAY_NO_SOURCES_RETRY_MS = 60_000;
export const DEFAULT_PROJECTION_WAKE_RELAY_FAILURE_BACKOFF_MS = 5_000;
export const DEFAULT_PROJECTION_WAKE_RELAY_FAILURE_BACKOFF_MAX_MS = 60_000;

export type ProjectionWakeRelaySupervisorState = Readonly<{
  running: boolean;
  sessionCount: number;
  lastSessionStatus: ProjectionWakeRelayActiveSessionStatus | "error" | null;
  lastSessionEndedAt: string | null;
  lastError: string | null;
}>;

export type ProjectionWakeRelaySupervisorSessionEndedEvent = Readonly<{
  status: ProjectionWakeRelayActiveSessionStatus | "error";
  sessionCount: number;
  retryDelayMs: number;
  error?: unknown;
}>;

export type ProjectionWakeRelaySupervisorObserver = Readonly<{
  sessionEnded?: (event: ProjectionWakeRelaySupervisorSessionEndedEvent) => void;
}>;

export type ProjectionWakeRelaySupervisorInput = Readonly<{
  runSession: (signal: AbortSignal) => Promise<ProjectionWakeRelayActiveSessionResult>;
  signal: AbortSignal;
  standbyRetryMs?: number;
  noSourcesRetryMs?: number;
  failureBackoffMs?: number;
  failureBackoffMaxMs?: number;
  observer?: ProjectionWakeRelaySupervisorObserver;
  now?: () => Date;
}>;

export type ProjectionWakeRelaySupervisor = Readonly<{
  done: Promise<void>;
  state: () => ProjectionWakeRelaySupervisorState;
}>;

export function startProjectionWakeRelaySupervisor(
  input: ProjectionWakeRelaySupervisorInput,
): ProjectionWakeRelaySupervisor {
  const now = input.now ?? (() => new Date());
  const standbyRetryMs = Math.max(
    250,
    Math.floor(input.standbyRetryMs ?? DEFAULT_PROJECTION_WAKE_RELAY_STANDBY_RETRY_MS),
  );
  const noSourcesRetryMs = Math.max(
    250,
    Math.floor(input.noSourcesRetryMs ?? DEFAULT_PROJECTION_WAKE_RELAY_NO_SOURCES_RETRY_MS),
  );
  const failureBackoffMs = Math.max(
    250,
    Math.floor(input.failureBackoffMs ?? DEFAULT_PROJECTION_WAKE_RELAY_FAILURE_BACKOFF_MS),
  );
  const failureBackoffMaxMs = Math.max(
    failureBackoffMs,
    Math.floor(input.failureBackoffMaxMs ?? DEFAULT_PROJECTION_WAKE_RELAY_FAILURE_BACKOFF_MAX_MS),
  );

  let sessionCount = 0;
  let lastSessionStatus: ProjectionWakeRelayActiveSessionStatus | "error" | null = null;
  let lastSessionEndedAt: string | null = null;
  let lastError: string | null = null;
  let running = !input.signal.aborted;
  let consecutiveFailures = 0;

  const notifySessionEnded = (event: ProjectionWakeRelaySupervisorSessionEndedEvent) => {
    try {
      input.observer?.sessionEnded?.(event);
    } catch {
      // Observers must never kill the supervisor loop.
    }
  };

  const done = (async () => {
    while (!input.signal.aborted) {
      let retryDelayMs: number;
      sessionCount += 1;

      try {
        const result = await input.runSession(input.signal);
        lastSessionStatus = result.status;
        lastError = null;
        consecutiveFailures = 0;
        // Lease-missed, lease-lost, and a clean "stopped" without an aborted
        // supervisor signal all retry on the standby interval.
        retryDelayMs = result.status === "no-enabled-sources" ? noSourcesRetryMs : standbyRetryMs;
        notifySessionEnded({ status: result.status, sessionCount, retryDelayMs });
      } catch (error) {
        consecutiveFailures += 1;
        lastSessionStatus = "error";
        lastError = error instanceof Error ? error.message : String(error);
        retryDelayMs = Math.min(failureBackoffMaxMs, failureBackoffMs * 2 ** Math.min(consecutiveFailures - 1, 10));
        notifySessionEnded({ status: "error", sessionCount, retryDelayMs, error });
      }

      lastSessionEndedAt = now().toISOString();
      if (input.signal.aborted) {
        break;
      }

      await sleepUnlessAborted(retryDelayMs, input.signal);
    }

    running = false;
  })();

  return {
    done,
    state: () => ({
      running,
      sessionCount,
      lastSessionStatus,
      lastSessionEndedAt,
      lastError,
    }),
  };
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fanOutEventStoreWakeNotification(
  input: ProjectionWakeRelayFanOutInput,
): Promise<ProjectionWakeRelayFanOutResult> {
  let notification: EventStoreWakeNotificationEnvelope;

  try {
    notification = parseEventStoreWakeNotificationEnvelope(input.notification);
  } catch (error) {
    input.observer?.notificationRejected?.({
      reason: error instanceof ProjectionWakeRelayNotificationRejectedError ? error.reason : "invalid-notification",
      error,
    });
    input.observer?.fanOutFailed?.({
      sourceContextName: null,
      streamCategory: null,
      lastGlobalPosition: null,
      reason: "invalid-notification",
      intentCount: 0,
      enqueuedCount: 0,
      error,
    });
    throw error;
  }

  const notificationContext = eventStoreWakeNotificationContext(notification);
  const relayConfig = findRelayConfig(notification.payload.sourceContextName, input.relayConfigs);

  if (!relayConfig?.relayFanOutEnabled) {
    input.observer?.sourceSkipped?.({
      ...notificationContext,
      reason: "source-disabled",
      relayFanOutEnabled: relayConfig?.relayFanOutEnabled ?? false,
      rolloutState: relayConfig?.rolloutState ?? null,
    });

    return {
      status: "skipped",
      skippedReason: "source-disabled",
      ...notificationContext,
      eventTypes: notification.payload.eventTypes,
      requiredCursor: sourceScopedCursor(notification.payload),
      priorityLane: relayConfig?.priorityLane ?? null,
      projectionInterestIndexVersion: input.projectionInterestIndex.indexVersion,
      intentCount: 0,
      enqueuedCount: 0,
      enqueuedWakeIntentIds: [],
      records: [],
    };
  }

  const requiredCursor = sourceScopedCursor(notification.payload);
  let intentInputs: readonly EnqueueProjectionWakeIntentInput[];

  try {
    intentInputs = createProjectionWakeIntentInputs(input.projectionInterestIndex, {
      sourceContextName: notification.payload.sourceContextName,
      eventTypes: notification.payload.eventTypes,
      requiredPosition: notification.payload.lastGlobalPosition,
      requiredCursor,
      origin: "relay",
      priorityLane: relayConfig.priorityLane,
      correlationId: notification.correlationId ?? null,
      metadata: projectionWakeRelayMetadata(notification, relayConfig, input.metadata),
    });
  } catch (error) {
    input.observer?.fanOutFailed?.({
      ...notificationContext,
      reason: fanOutFailureReason(error),
      intentCount: 0,
      enqueuedCount: 0,
      error,
    });
    throw error;
  }

  if (intentInputs.length === 0) {
    input.observer?.fanOutSkipped?.({
      ...notificationContext,
      requiredCursor,
      reason: "no-interests",
      projectionInterestIndexVersion: input.projectionInterestIndex.indexVersion,
    });

    return {
      status: "skipped",
      skippedReason: "no-interests",
      ...notificationContext,
      eventTypes: notification.payload.eventTypes,
      requiredCursor,
      priorityLane: relayConfig.priorityLane,
      projectionInterestIndexVersion: input.projectionInterestIndex.indexVersion,
      intentCount: 0,
      enqueuedCount: 0,
      enqueuedWakeIntentIds: [],
      records: [],
    };
  }

  const records: ProjectionWakeIntentRecord[] = [];

  try {
    for (const intent of intentInputs) {
      records.push(await input.workSignalStore.enqueueProjectionWakeIntent(intent));
    }
  } catch (error) {
    input.observer?.fanOutFailed?.({
      ...notificationContext,
      reason: "enqueue-failed",
      intentCount: intentInputs.length,
      enqueuedCount: records.length,
      error,
    });
    throw error;
  }

  const result = {
    status: "enqueued" as const,
    skippedReason: null,
    ...notificationContext,
    eventTypes: notification.payload.eventTypes,
    requiredCursor,
    priorityLane: relayConfig.priorityLane,
    projectionInterestIndexVersion: input.projectionInterestIndex.indexVersion,
    intentCount: intentInputs.length,
    enqueuedCount: records.length,
    enqueuedWakeIntentIds: records.map((record) => record.wakeIntentId),
    records,
  };

  input.observer?.fanOutSucceeded?.({
    ...notificationContext,
    requiredCursor,
    priorityLane: relayConfig.priorityLane,
    projectionInterestIndexVersion: input.projectionInterestIndex.indexVersion,
    intentCount: result.intentCount,
    enqueuedCount: result.enqueuedCount,
    enqueuedWakeIntentIds: result.enqueuedWakeIntentIds,
    notificationAgeMs: wakeNotificationAgeMs(notification.emittedAt),
  });

  return result;
}

type ActiveProjectionWakeRelaySource = Readonly<{
  source: ProjectionWakeRelaySourceRuntime;
  config: SourceContextWakeRelayConfig;
}>;

type ProjectionWakeRelaySourceCatchUpResult = Readonly<{
  eventCount: number;
  cursorAdvanceCount: number;
  lastFanOutPosition: string | null;
}>;

type ProjectionWakeRelaySourceState = {
  readonly input: ProjectionWakeRelayActiveSessionInput;
  readonly source: ProjectionWakeRelaySourceRuntime;
  readonly config: SourceContextWakeRelayConfig;
  readonly lease: PlatformLease;
  readonly signal: AbortSignal;
  readonly onCatchUpResult: (result: ProjectionWakeRelaySourceCatchUpResult) => void;
  processing: Promise<void>;
  stopped: boolean;
  listenerClient: ProjectionWakeRelayListenerClient | null;
  notificationListener: ((message?: Readonly<{ channel?: string; payload?: string }>) => void) | null;
  errorListener: ((message?: Readonly<{ channel?: string; payload?: string }>) => void) | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

function selectActiveRelaySources(
  sources: readonly ProjectionWakeRelaySourceRuntime[],
  relayConfigs: readonly SourceContextWakeRelayConfig[],
): readonly ActiveProjectionWakeRelaySource[] {
  const sourcesByContext = new Map(sources.map((source) => [source.sourceContextName, source]));

  return relayConfigs.flatMap((config) => {
    if (!config.relayFanOutEnabled) {
      return [];
    }

    const source = sourcesByContext.get(config.sourceContextName);
    return source ? [{ source, config }] : [];
  });
}

function createRelaySourceState(
  input: ProjectionWakeRelayActiveSessionInput,
  source: ProjectionWakeRelaySourceRuntime,
  config: SourceContextWakeRelayConfig,
  lease: PlatformLease,
  signal: AbortSignal,
  onCatchUpResult: (result: ProjectionWakeRelaySourceCatchUpResult) => void,
): ProjectionWakeRelaySourceState {
  return {
    input,
    source,
    config,
    lease,
    signal,
    onCatchUpResult,
    processing: Promise.resolve(),
    stopped: false,
    listenerClient: null,
    notificationListener: null,
    errorListener: null,
    reconnectTimer: null,
  };
}

async function connectSourceListener(state: ProjectionWakeRelaySourceState): Promise<boolean> {
  if (state.signal.aborted || state.stopped || !state.source.listenerPool) {
    return false;
  }

  const channel = assertPostgresEventStoreWakeNotificationChannel(
    state.config.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  );

  try {
    const client = (await state.source.listenerPool.connect()) as ProjectionWakeRelayListenerClient;
    const onNotification = (message?: Readonly<{ channel?: string; payload?: string }>) => {
      if (message?.channel !== channel) {
        return;
      }

      state.input.observer?.notificationReceived?.({
        sourceContextName: state.source.sourceContextName,
        channel,
        payloadBytes: message.payload ? byteLengthUtf8(message.payload) : 0,
      });
      void enqueueSourceCatchUp(state, "notification", { fatal: false });
    };
    const onError = (message?: Readonly<{ channel?: string; payload?: string }>) => {
      state.input.observer?.listenerDisconnected?.({
        sourceContextName: state.source.sourceContextName,
        channel,
        error: message,
      });
      void disconnectSourceListener(state).finally(() => scheduleSourceListenerReconnect(state));
    };

    state.listenerClient = client;
    state.notificationListener = onNotification;
    state.errorListener = onError;
    client.on?.("notification", onNotification);
    client.on?.("error", onError);

    await client.query(`LISTEN ${channel}`);
    state.input.observer?.listenerConnected?.({
      sourceContextName: state.source.sourceContextName,
      channel,
    });
    return true;
  } catch (error) {
    state.input.observer?.listenerUnavailable?.({
      sourceContextName: state.source.sourceContextName,
      channel,
      error,
    });
    await disconnectSourceListener(state);
    scheduleSourceListenerReconnect(state);
    return false;
  }
}

function scheduleSourceListenerReconnect(state: ProjectionWakeRelaySourceState): void {
  if (state.signal.aborted || state.stopped || !state.source.listenerPool || state.reconnectTimer) {
    return;
  }

  const reconnectBackoffMs = Math.max(
    100,
    Math.floor(state.input.reconnectBackoffMs ?? DEFAULT_PROJECTION_WAKE_RELAY_RECONNECT_BACKOFF_MS),
  );
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectSourceListener(state)
      .then((connected) => (connected ? enqueueSourceCatchUp(state, "reconnect", { fatal: false }) : undefined))
      .catch((error: unknown) => {
        state.input.observer?.sourceCatchUpFailed?.({
          sourceContextName: state.source.sourceContextName,
          reason: "reconnect",
          error,
        });
      });
  }, reconnectBackoffMs);
  state.reconnectTimer.unref?.();
}

async function stopSourceListener(state: ProjectionWakeRelaySourceState): Promise<void> {
  state.stopped = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  await disconnectSourceListener(state);
}

async function disconnectSourceListener(state: ProjectionWakeRelaySourceState): Promise<void> {
  const client = state.listenerClient;
  const channel = assertPostgresEventStoreWakeNotificationChannel(
    state.config.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  );

  if (!client) {
    return;
  }

  if (state.notificationListener) {
    removePostgresListener(client, "notification", state.notificationListener);
  }
  if (state.errorListener) {
    removePostgresListener(client, "error", state.errorListener);
  }

  state.listenerClient = null;
  state.notificationListener = null;
  state.errorListener = null;

  let disconnectError: unknown;
  try {
    await client.query(`UNLISTEN ${channel}`);
  } catch (error) {
    disconnectError = error;
  } finally {
    client.release();
  }

  if (disconnectError) {
    state.input.observer?.listenerDisconnected?.({
      sourceContextName: state.source.sourceContextName,
      channel,
      error: disconnectError,
    });
  }
}

function removePostgresListener(
  client: ProjectionWakeRelayListenerClient,
  event: "notification" | "error",
  listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
): void {
  if (client.off) {
    client.off(event, listener);
    return;
  }

  client.removeListener?.(event, listener);
}

function enqueueSourceCatchUp(
  state: ProjectionWakeRelaySourceState,
  reason: ProjectionWakeRelayCatchUpReason,
  options: Readonly<{ fatal: boolean }> = { fatal: true },
): Promise<void> {
  const operation = state.processing
    .then(async () => {
      const result = await catchUpRelaySource(state, reason);
      state.onCatchUpResult(result);
    })
    .catch((error: unknown) => {
      state.input.observer?.sourceCatchUpFailed?.({
        sourceContextName: state.source.sourceContextName,
        reason,
        error,
      });
      if (options.fatal) {
        throw error;
      }
    });

  state.processing = operation.catch(() => undefined);
  return operation;
}

async function catchUpRelaySource(
  state: ProjectionWakeRelaySourceState,
  reason: ProjectionWakeRelayCatchUpReason,
): Promise<ProjectionWakeRelaySourceCatchUpResult> {
  const now = state.input.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const cursor = await state.input.controlPlane.getProjectionWakeRelayCursor(state.source.sourceContextName);
  let afterGlobalPosition = cursorPosition(cursor);
  let eventCount = 0;
  let cursorAdvanceCount = 0;
  let lastFanOutPosition: string | null = null;
  const batchSize = Math.max(
    1,
    Math.floor(state.input.catchUpBatchSize ?? DEFAULT_PROJECTION_WAKE_RELAY_CATCH_UP_BATCH_SIZE),
  );

  state.input.observer?.sourceCatchUpStarted?.({
    sourceContextName: state.source.sourceContextName,
    reason,
    afterGlobalPosition,
  });

  while (!state.signal.aborted) {
    const events = await state.source.eventStore.readAll({
      afterGlobalPosition: parseGlobalPosition(afterGlobalPosition),
      streamPrefixes: sourceStreamPrefixes(state.source),
      limit: batchSize,
    });

    if (events.length === 0) {
      break;
    }

    const sourceEvents = events.filter((event) => eventBelongsToSource(event, state.source));
    if (sourceEvents.length === 0) {
      break;
    }

    for (const group of groupCatchUpEvents(sourceEvents)) {
      const notification = createCatchUpWakeNotificationEnvelope({
        source: state.source,
        events: group,
        now,
      });
      const fanOutResult = await fanOutEventStoreWakeNotification({
        notification,
        projectionInterestIndex: state.input.projectionInterestIndex,
        workSignalStore: state.input.workSignalStore,
        relayConfigs: [state.config],
        metadata: {
          projectionWakeRelayCatchUpReason: reason,
          projectionWakeRelayLeaseName: state.lease.leaseName,
          projectionWakeRelayOwnerId: state.lease.ownerId,
          projectionWakeRelayFencingToken: state.lease.fencingToken,
        },
        observer: state.input.observer,
      });
      const advanced = await state.input.controlPlane.advanceProjectionWakeRelayCursor({
        sourceContextName: state.source.sourceContextName,
        lastFanOutPosition: fanOutResult.lastGlobalPosition,
        lastRequiredCursor: fanOutResult.requiredCursor,
        lease: state.lease,
        metadata: {
          reason,
          streamCategory: fanOutResult.streamCategory,
          projectionInterestIndexVersion: fanOutResult.projectionInterestIndexVersion,
        },
      });

      if (!advanced || advanced.lastFanOutPosition < BigInt(fanOutResult.lastGlobalPosition)) {
        throw new Error(
          `Projection wake relay cursor advance was rejected for source '${state.source.sourceContextName}'.`,
        );
      }

      eventCount += group.length;
      cursorAdvanceCount += 1;
      afterGlobalPosition = fanOutResult.lastGlobalPosition;
      lastFanOutPosition = fanOutResult.lastGlobalPosition;
      state.input.observer?.cursorAdvanced?.({
        sourceContextName: state.source.sourceContextName,
        reason,
        lastFanOutPosition: fanOutResult.lastGlobalPosition,
        lastRequiredCursor: fanOutResult.requiredCursor,
        ownerId: advanced.ownerId,
        fencingToken: advanced.fencingToken,
      });
    }

    if (events.length < batchSize) {
      break;
    }
  }

  state.input.observer?.sourceCatchUpCompleted?.({
    sourceContextName: state.source.sourceContextName,
    reason,
    eventCount,
    cursorAdvanceCount,
    lastFanOutPosition,
    durationMs: Math.max(0, now().getTime() - startedAtMs),
  });

  return {
    eventCount,
    cursorAdvanceCount,
    lastFanOutPosition,
  };
}

function cursorPosition(cursor: ProjectionWakeRelayCursorRecord | null): string {
  return cursor ? cursor.lastFanOutPosition.toString() : ZERO_GLOBAL_POSITION;
}

function sourceStreamPrefixes(source: ProjectionWakeRelaySourceRuntime): readonly string[] {
  return source.streamPrefixes?.length ? source.streamPrefixes : [`${source.sourceContextName}.`];
}

function eventBelongsToSource(event: StoredEvent, source: ProjectionWakeRelaySourceRuntime): boolean {
  return sourceStreamPrefixes(source).some((prefix) => event.streamId.startsWith(prefix));
}

function groupCatchUpEvents(events: readonly StoredEvent[]): readonly (readonly StoredEvent[])[] {
  const groups: StoredEvent[][] = [];
  let current: StoredEvent[] = [];
  let currentStreamCategory: string | null = null;

  for (const event of events) {
    const category = streamCategory(event.streamId);
    if (current.length > 0 && currentStreamCategory !== category) {
      groups.push(current);
      current = [];
    }
    current.push(event);
    currentStreamCategory = category;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function createCatchUpWakeNotificationEnvelope(input: {
  source: ProjectionWakeRelaySourceRuntime;
  events: readonly StoredEvent[];
  now: () => Date;
}): EventStoreWakeNotificationEnvelope {
  const firstEvent = input.events[0];
  const lastEvent = input.events[input.events.length - 1];

  if (!firstEvent || !lastEvent) {
    throw new Error("Projection wake relay catch-up requires at least one source event.");
  }

  return {
    schemaVersion: EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION,
    payloadVersion: EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION,
    kind: EVENT_STORE_WAKE_NOTIFICATION_KIND,
    source: DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
    // Use the durable recording time of the newest event in the batch so the
    // fan-out age metric measures real commit-to-fan-out latency. The
    // synthetic envelope's own creation time would always read ~0.
    emittedAt: lastEvent.recordedAt ?? parseIsoUtcTimestamp(input.now().toISOString()),
    ...(firstEvent.traceId ? { correlationId: firstEvent.traceId } : {}),
    payload: {
      sourceContextName: input.source.sourceContextName,
      streamCategory: streamCategory(firstEvent.streamId),
      firstGlobalPosition: firstEvent.globalPosition,
      lastGlobalPosition: lastEvent.globalPosition,
      eventCount: input.events.length,
      eventTypes: [...new Set(input.events.map((event) => event.eventType))].sort((left, right) =>
        left.localeCompare(right),
      ),
    },
  };
}

function streamCategory(streamId: string): string {
  const lastDashIndex = streamId.lastIndexOf("-");
  return lastDashIndex > 0 ? streamId.slice(0, lastDashIndex) : streamId;
}

function waitForProjectionWakeRelayAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function parseEventStoreWakeNotificationEnvelope(notification: unknown): EventStoreWakeNotificationEnvelope {
  const value = parseJsonNotification(notification);

  if (!isRecord(value)) {
    throw new ProjectionWakeRelayNotificationRejectedError("envelope must be a JSON object");
  }

  if (value.schemaVersion !== EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION) {
    throw new ProjectionWakeRelayNotificationRejectedError(
      `unsupported schemaVersion '${String(value.schemaVersion)}'`,
    );
  }

  if (value.payloadVersion !== EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION) {
    throw new ProjectionWakeRelayNotificationRejectedError(
      `unsupported payloadVersion '${String(value.payloadVersion)}'`,
    );
  }

  if (value.kind !== EVENT_STORE_WAKE_NOTIFICATION_KIND) {
    throw new ProjectionWakeRelayNotificationRejectedError(`unsupported kind '${String(value.kind)}'`);
  }

  const source = requireNonEmptyString(value, "source");
  const emittedAt = requireIsoTimestamp(value, "emittedAt");
  const correlationId = optionalNonEmptyString(value, "correlationId");
  const payload = parseEventStoreWakeNotificationPayload(value.payload);

  return {
    schemaVersion: EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION,
    payloadVersion: EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION,
    kind: EVENT_STORE_WAKE_NOTIFICATION_KIND,
    source,
    emittedAt,
    ...(correlationId ? { correlationId } : {}),
    payload,
  };
}

function parseJsonNotification(notification: unknown): unknown {
  if (typeof notification !== "string") {
    return notification;
  }

  try {
    return JSON.parse(notification) as unknown;
  } catch (error) {
    throw new ProjectionWakeRelayNotificationRejectedError("payload is not valid JSON", { cause: error });
  }
}

function parseEventStoreWakeNotificationPayload(payload: unknown): EventStoreWakeNotificationPayload {
  if (!isRecord(payload)) {
    throw new ProjectionWakeRelayNotificationRejectedError("payload must be a JSON object");
  }

  const sourceContextName = requireNonEmptyString(payload, "sourceContextName");
  const streamCategory = requireNonEmptyString(payload, "streamCategory");
  const firstGlobalPosition = requireGlobalPosition(payload, "firstGlobalPosition");
  const lastGlobalPosition = requireGlobalPosition(payload, "lastGlobalPosition");
  const eventCount = requirePositiveInteger(payload, "eventCount");
  const eventTypes = requireNonEmptyStringArray(payload, "eventTypes");

  if (BigInt(lastGlobalPosition) < BigInt(firstGlobalPosition)) {
    throw new ProjectionWakeRelayNotificationRejectedError("lastGlobalPosition must be >= firstGlobalPosition");
  }

  return {
    sourceContextName,
    streamCategory,
    firstGlobalPosition,
    lastGlobalPosition,
    eventCount,
    eventTypes,
  };
}

function findRelayConfig(
  sourceContextName: string,
  relayConfigs: readonly SourceContextWakeRelayConfig[] = listSourceContextWakeRelayConfigs(),
): SourceContextWakeRelayConfig | null {
  return relayConfigs.find((config) => config.sourceContextName === sourceContextName) ?? null;
}

function eventStoreWakeNotificationContext(notification: EventStoreWakeNotificationEnvelope) {
  return {
    sourceContextName: notification.payload.sourceContextName,
    streamCategory: notification.payload.streamCategory,
    firstGlobalPosition: String(notification.payload.firstGlobalPosition),
    lastGlobalPosition: String(notification.payload.lastGlobalPosition),
  };
}

function sourceScopedCursor(payload: EventStoreWakeNotificationPayload): string {
  return `${payload.sourceContextName}:${String(payload.lastGlobalPosition)}`;
}

function wakeNotificationAgeMs(emittedAt: IsoUtcTimestamp): number | null {
  const ageMs = Date.now() - Date.parse(emittedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null;
}

function projectionWakeRelayMetadata(
  notification: EventStoreWakeNotificationEnvelope,
  relayConfig: SourceContextWakeRelayConfig,
  metadata: JsonRecord | undefined,
): JsonRecord {
  assertSafeRelayMetadata(metadata);

  return {
    ...(metadata ?? {}),
    projectionWakeRelaySchemaVersion: PROJECTION_WAKE_RELAY_FAN_OUT_SCHEMA_VERSION,
    projectionWakeRelayMetadataVersion: PROJECTION_WAKE_RELAY_FAN_OUT_METADATA_VERSION,
    eventStoreWakeSource: notification.source,
    eventStoreWakeEmittedAt: notification.emittedAt,
    eventStoreWakeStreamCategory: notification.payload.streamCategory,
    eventStoreWakeFirstGlobalPosition: String(notification.payload.firstGlobalPosition),
    eventStoreWakeLastGlobalPosition: String(notification.payload.lastGlobalPosition),
    eventStoreWakeEventCount: notification.payload.eventCount,
    eventStoreWakeEventTypes: notification.payload.eventTypes,
    eventStoreWakeSchemaVersion: notification.schemaVersion,
    eventStoreWakePayloadVersion: notification.payloadVersion,
    sourceContextWakeRolloutState: relayConfig.rolloutState,
    sourceContextWakeRolloutWave: relayConfig.rolloutWave,
    sourceContextWakePhase: relayConfig.phase,
  };
}

function fanOutFailureReason(error: unknown): ProjectionWakeRelayFanOutFailureReason {
  if (error instanceof ProjectionInterestIndexStaleError) {
    return "stale-interest-index";
  }

  return "unexpected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a non-empty string`);
  }

  return value.trim();
}

function optionalNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a non-empty string when present`);
  }

  return value.trim();
}

function requireIsoTimestamp(record: Record<string, unknown>, key: string): IsoUtcTimestamp {
  const value = requireNonEmptyString(record, key);
  try {
    return parseIsoUtcTimestamp(value);
  } catch {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a valid timestamp`);
  }
}

function requireGlobalPosition(record: Record<string, unknown>, key: string): GlobalPosition {
  const value = record[key];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a non-negative integer position`);
  }

  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a non-negative integer position`);
  }

  try {
    return parseGlobalPosition(text);
  } catch {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a non-negative integer position`);
  }
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be a positive integer`);
  }

  return value;
}

function requireNonEmptyStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must be an array`);
  }

  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ProjectionWakeRelayNotificationRejectedError(`${key} must contain only non-empty strings`);
    }

    return entry.trim();
  });

  if (strings.length === 0) {
    throw new ProjectionWakeRelayNotificationRejectedError(`${key} must contain at least one event type`);
  }

  return [...new Set(strings)].sort((left, right) => left.localeCompare(right));
}

const SENSITIVE_RELAY_METADATA_KEY_PATTERN =
  /(^|_|\b)(email|guestEmail|payment|card|pan|cvc|cvv|password|secret|privatePayload|providerPayload|eventPayload|rawPayload|payloadJson|phone|address|tenantId|userId|accountId|streamId|sessionId)(_|$|\b)/i;

function assertSafeRelayMetadata(value: unknown, path: readonly string[] = []): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeRelayMetadata(entry, [...path, String(index)]));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (SENSITIVE_RELAY_METADATA_KEY_PATTERN.test(key)) {
      throw new Error(`Projection wake relay metadata key '${nextPath.join(".")}' is not allowed.`);
    }
    assertSafeRelayMetadata(nestedValue, nextPath);
  }
}

function byteLengthUtf8(value: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : new TextEncoder().encode(value).length;
}
