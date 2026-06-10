import {
  EVENT_STORE_WAKE_NOTIFICATION_KIND,
  EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION,
  EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION,
  type EventStoreWakeNotificationEnvelope,
  type EventStoreWakeNotificationPayload,
} from "@chase-sets/event-core-postgres";
import { parseGlobalPosition, type GlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";

import {
  createProjectionWakeIntentInputs,
  ProjectionInterestIndexStaleError,
  type ProjectionInterestIndex,
} from "./projection-interest-index";
import { listSourceContextWakeRelayConfigs, type SourceContextWakeRelayConfig } from "./source-context-wake-registry";
import type {
  EnqueueProjectionWakeIntentInput,
  JsonRecord,
  PostgresWorkSignalStore,
  ProjectionWakeIntentRecord,
  WorkSignalPriorityLane,
} from "./work-signal-store";

export const PROJECTION_WAKE_RELAY_FAN_OUT_SCHEMA_VERSION = 1;
export const PROJECTION_WAKE_RELAY_FAN_OUT_METADATA_VERSION = 1;

export type ProjectionWakeRelayFanOutStatus = "enqueued" | "skipped";
export type ProjectionWakeRelaySkippedReason = "source-disabled" | "no-interests";
export type ProjectionWakeRelayFanOutFailureReason =
  | "invalid-notification"
  | "stale-interest-index"
  | "enqueue-failed"
  | "unexpected";

export type ProjectionWakeRelayWorkSignalStore = Pick<PostgresWorkSignalStore, "enqueueProjectionWakeIntent">;

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
  });

  return result;
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
