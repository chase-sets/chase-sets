import {
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  type EventStoreWakeNotificationFailedEvent,
  type EventStoreWakeNotificationPayloadRejectedEvent,
  type PostgresEventStoreWakeNotificationConfig,
} from "@chase-sets/event-core-postgres";

import type { WorkSignalPriorityLane } from "./work-signal-store";
import {
  isSourceContextWakeActive,
  SOURCE_CONTEXT_WAKE_ROLLOUT_STATES,
  SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES,
  validateSourceContextWakeRegistryEntry,
  type SourceContextWakeLoadEstimate,
  type SourceContextWakePhase,
  type SourceContextWakeRegistryEntry,
  type SourceContextWakeRolloutState,
  type SourceContextWakeRolloutWave,
} from "./source-context-wake-registry-entry";
import { authWakeRegistryEntry } from "./source-context-wake-registry/auth";
import { authenticityWakeRegistryEntry } from "./source-context-wake-registry/authenticity";
import { catalogWakeRegistryEntry } from "./source-context-wake-registry/catalog";
import { channelsWakeRegistryEntry } from "./source-context-wake-registry/channels";
import { checkoutWakeRegistryEntry } from "./source-context-wake-registry/checkout";
import { collectionsWakeRegistryEntry } from "./source-context-wake-registry/collections";
import { commercialTermsWakeRegistryEntry } from "./source-context-wake-registry/commercial-terms";
import { customerFeedbackWakeRegistryEntry } from "./source-context-wake-registry/customer-feedback";
import { discoveryWakeRegistryEntry } from "./source-context-wake-registry/discovery";
import { fulfillmentWakeRegistryEntry } from "./source-context-wake-registry/fulfillment";
import { identityWakeRegistryEntry } from "./source-context-wake-registry/identity";
import { inventoryWakeRegistryEntry } from "./source-context-wake-registry/inventory";
import { marketplaceWakeRegistryEntry } from "./source-context-wake-registry/marketplace";
import { notificationsWakeRegistryEntry } from "./source-context-wake-registry/notifications";
import { orderingWakeRegistryEntry } from "./source-context-wake-registry/ordering";
import { paymentsWakeRegistryEntry } from "./source-context-wake-registry/payments";
import { platformOperationsWakeRegistryEntry } from "./source-context-wake-registry/platform-operations";
import { pricingWakeRegistryEntry } from "./source-context-wake-registry/pricing";
import { publicPresenceWakeRegistryEntry } from "./source-context-wake-registry/public-presence";
import { settlementWakeRegistryEntry } from "./source-context-wake-registry/settlement";

export {
  SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES,
  type SourceContextWakeEnablement,
  type SourceContextWakeLoadEstimate,
  type SourceContextWakePhase,
  type SourceContextWakeRegistryEntry,
  type SourceContextWakeRolloutState,
  type SourceContextWakeRolloutWave,
} from "./source-context-wake-registry-entry";

export type SourceContextWakeRegistrySummary = Readonly<{
  entryCount: number;
  activeEntryCount: number;
  enabledEventStoreWakeContextCount: number;
  enabledRelayFanOutContextCount: number;
  rolloutStateCounts: readonly Readonly<{
    rolloutState: SourceContextWakeRolloutState;
    count: number;
  }>[];
  rolloutWaveCounts: readonly Readonly<{
    rolloutWave: SourceContextWakeRolloutWave;
    count: number;
  }>[];
}>;

export type SourceContextWakeRelayConfig = Readonly<{
  sourceContextName: string;
  channel: string;
  rolloutState: SourceContextWakeRolloutState;
  phase: SourceContextWakePhase;
  rolloutWave: SourceContextWakeRolloutWave;
  priorityLane: WorkSignalPriorityLane;
  relayFanOutEnabled: boolean;
  expectedEventVolume: SourceContextWakeLoadEstimate;
  wakeStoreLoadEstimate: SourceContextWakeLoadEstimate;
  requiredIssueNumbers: readonly number[];
  productionEvidenceIssueNumbers: readonly number[];
}>;

export type ListSourceContextWakeRegistryEntriesInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  rolloutStates?: readonly SourceContextWakeRolloutState[];
  rolloutWaves?: readonly SourceContextWakeRolloutWave[];
  phases?: readonly SourceContextWakePhase[];
  includeInactive?: boolean;
}>;

export type SourceContextWakeNotificationConfigInput = Readonly<{
  sourceContextName: string;
  registry?: readonly SourceContextWakeRegistryEntry[];
  channel?: string;
  source?: string;
  maxPayloadBytes?: number;
}>;

export type ListSourceContextWakeRelayConfigsInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  channel?: string;
  includeInactive?: boolean;
}>;

export type ValidateSourceContextWakeRegistryInput = Readonly<{
  registry?: readonly SourceContextWakeRegistryEntry[];
  boundedContextNames?: readonly string[];
}>;

/**
 * Static aggregate of the per-context shard modules in
 * `./source-context-wake-registry/`. Entry content churns with every rollout
 * state change and lives in the owning context's shard; this file changes only
 * when registry membership changes, so concurrent rollout PRs stop colliding.
 * Shard filename, module export, and `sourceContextName` are kept in lockstep
 * by the membership partition test in `./source-context-wake-registry.test.ts`.
 */
export const sourceContextWakeRegistry = [
  authWakeRegistryEntry,
  authenticityWakeRegistryEntry,
  catalogWakeRegistryEntry,
  channelsWakeRegistryEntry,
  checkoutWakeRegistryEntry,
  collectionsWakeRegistryEntry,
  commercialTermsWakeRegistryEntry,
  customerFeedbackWakeRegistryEntry,
  discoveryWakeRegistryEntry,
  fulfillmentWakeRegistryEntry,
  identityWakeRegistryEntry,
  inventoryWakeRegistryEntry,
  marketplaceWakeRegistryEntry,
  notificationsWakeRegistryEntry,
  orderingWakeRegistryEntry,
  paymentsWakeRegistryEntry,
  platformOperationsWakeRegistryEntry,
  pricingWakeRegistryEntry,
  publicPresenceWakeRegistryEntry,
  settlementWakeRegistryEntry,
] as const satisfies readonly SourceContextWakeRegistryEntry[];

export function validateSourceContextWakeRegistry(input: ValidateSourceContextWakeRegistryInput = {}): void {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const seenSourceContextNames = new Set<string>();

  if (registry.length === 0) {
    throw new Error("Source-context wake registry must contain at least one entry.");
  }

  for (const entry of registry) {
    validateSourceContextWakeRegistryEntry(entry);

    if (seenSourceContextNames.has(entry.sourceContextName)) {
      throw new Error(`Source-context wake registry contains duplicate entry '${entry.sourceContextName}'.`);
    }
    seenSourceContextNames.add(entry.sourceContextName);
  }

  if (input.boundedContextNames) {
    assertRegistryCoversBoundedContexts(registry, input.boundedContextNames);
  }
}

export function listSourceContextWakeRegistryEntries(
  input: ListSourceContextWakeRegistryEntriesInput = {},
): readonly SourceContextWakeRegistryEntry[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const rolloutStates = input.rolloutStates ? new Set(input.rolloutStates) : null;
  const rolloutWaves = input.rolloutWaves ? new Set(input.rolloutWaves) : null;
  const phases = input.phases ? new Set(input.phases) : null;

  return registry.filter(
    (entry) =>
      (!rolloutStates || rolloutStates.has(entry.rolloutState)) &&
      (!rolloutWaves || rolloutWaves.has(entry.rolloutWave)) &&
      (!phases || phases.has(entry.phase)) &&
      (input.includeInactive || isSourceContextWakeActive(entry) || entry.rolloutState === "eligible"),
  );
}

function getSourceContextWakeRegistryEntry(
  sourceContextName: string,
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistryEntry | null {
  return registry.find((entry) => entry.sourceContextName === sourceContextName) ?? null;
}

export function requireSourceContextWakeRegistryEntry(
  sourceContextName: string,
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistryEntry {
  const entry = getSourceContextWakeRegistryEntry(sourceContextName, registry);
  if (!entry) {
    throw new Error(`Source context '${sourceContextName}' is not present in the wake registry.`);
  }
  return entry;
}

export const PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED_ENV = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED";
export const PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS_ENV = "PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS";

/**
 * Deployment-level kill switch for write-side event-store wake emission. The
 * registry is environment-global, so environments that must stay inert (for
 * example production before its proof gates pass) set this to "false" to
 * force every registry-derived emission config off without a code change.
 *
 * Parsing matches the worker boolean-env convention: unset keeps the default
 * (enabled); any value outside the affirmative set disables emission, so a
 * typo can never silently enable a production emitter.
 */
export function isEventStoreWakeNotificationEmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED_ENV]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return true;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

export function isProjectionWakeSourceContextEnabled(
  sourceContextName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const rawValue = env[PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS_ENV]?.trim();
  if (rawValue === undefined || rawValue === "" || rawValue === "*") {
    return true;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(sourceContextName);
}

export function createEventStoreWakeNotificationConfigForSourceContext(
  input: SourceContextWakeNotificationConfigInput,
): PostgresEventStoreWakeNotificationConfig {
  const entry = requireSourceContextWakeRegistryEntry(input.sourceContextName, input.registry);
  validateSourceContextWakeRegistryEntry(entry);

  return {
    enabled:
      entry.enablement.eventStoreWakeNotifications &&
      isEventStoreWakeNotificationEmissionEnabled() &&
      isProjectionWakeSourceContextEnabled(entry.sourceContextName),
    channel: input.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
    source: input.source ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
    ...(input.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: input.maxPayloadBytes }),
    observer: createEventStoreWakeNotificationObserver(),
  };
}

function createEventStoreWakeNotificationObserver(): NonNullable<PostgresEventStoreWakeNotificationConfig["observer"]> {
  return {
    notificationFailed: (event) => {
      console.warn("Event-store wake notification failed after commit; projections fall back to bounded polling.", {
        type: "event_store_wake.notification_failed",
        channel: event.channel,
        sourceContextName: event.sourceContextName,
        streamCategory: event.streamCategory,
        firstGlobalPosition: event.firstGlobalPosition,
        lastGlobalPosition: event.lastGlobalPosition,
        eventCount: event.eventCount,
        correlationId: event.correlationId,
        error: eventStoreWakeNotificationErrorSummary(event.error),
      } satisfies EventStoreWakeNotificationFailedLog);
    },
    payloadRejected: (event) => {
      console.warn("Event-store wake notification payload rejected; projections fall back to bounded polling.", {
        type: "event_store_wake.payload_rejected",
        channel: event.channel,
        sourceContextName: event.sourceContextName,
        streamCategory: event.streamCategory,
        firstGlobalPosition: event.firstGlobalPosition,
        lastGlobalPosition: event.lastGlobalPosition,
        eventCount: event.eventCount,
        correlationId: event.correlationId,
        reason: event.reason,
      } satisfies EventStoreWakeNotificationPayloadRejectedLog);
    },
  };
}

type EventStoreWakeNotificationFailedLog = Omit<EventStoreWakeNotificationFailedEvent, "error"> &
  Readonly<{
    type: "event_store_wake.notification_failed";
    error: string;
  }>;

type EventStoreWakeNotificationPayloadRejectedLog = EventStoreWakeNotificationPayloadRejectedEvent &
  Readonly<{
    type: "event_store_wake.payload_rejected";
  }>;

function eventStoreWakeNotificationErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function listEventStoreWakeNotificationSourceContexts(
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): readonly SourceContextWakeRegistryEntry[] {
  return registry.filter((entry) => entry.enablement.eventStoreWakeNotifications);
}

export function listSourceContextWakeRelayConfigs(
  input: ListSourceContextWakeRelayConfigsInput = {},
): readonly SourceContextWakeRelayConfig[] {
  const registry = input.registry ?? sourceContextWakeRegistry;
  const channel = input.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL;

  return registry
    .filter((entry) => input.includeInactive || entry.enablement.relayFanOut)
    .filter((entry) => input.includeInactive || isProjectionWakeSourceContextEnabled(entry.sourceContextName))
    .map((entry) => ({
      sourceContextName: entry.sourceContextName,
      channel,
      rolloutState: entry.rolloutState,
      phase: entry.phase,
      rolloutWave: entry.rolloutWave,
      priorityLane: entry.priorityLane,
      relayFanOutEnabled: entry.enablement.relayFanOut,
      expectedEventVolume: entry.expectedEventVolume,
      wakeStoreLoadEstimate: entry.wakeStoreLoadEstimate,
      requiredIssueNumbers: entry.requiredIssueNumbers,
      productionEvidenceIssueNumbers: entry.productionEvidenceIssueNumbers,
    }));
}

export function summarizeSourceContextWakeRegistry(
  registry: readonly SourceContextWakeRegistryEntry[] = sourceContextWakeRegistry,
): SourceContextWakeRegistrySummary {
  return {
    entryCount: registry.length,
    activeEntryCount: registry.filter(isSourceContextWakeActive).length,
    enabledEventStoreWakeContextCount: registry.filter((entry) => entry.enablement.eventStoreWakeNotifications).length,
    enabledRelayFanOutContextCount: registry.filter((entry) => entry.enablement.relayFanOut).length,
    rolloutStateCounts: countRolloutStates(registry),
    rolloutWaveCounts: countRolloutWaves(registry),
  };
}

function assertRegistryCoversBoundedContexts(
  registry: readonly SourceContextWakeRegistryEntry[],
  boundedContextNames: readonly string[],
): void {
  const registryNames = new Set(registry.map((entry) => entry.sourceContextName));
  const contextNames = new Set(boundedContextNames);
  const missing = [...contextNames].filter((contextName) => !registryNames.has(contextName)).sort();
  const unknown = [...registryNames].filter((contextName) => !contextNames.has(contextName)).sort();

  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Source-context wake registry coverage mismatch. Missing: ${missing.join(", ") || "none"}. Unknown: ${
        unknown.join(", ") || "none"
      }.`,
    );
  }
}

function countRolloutStates(
  entries: readonly SourceContextWakeRegistryEntry[],
): SourceContextWakeRegistrySummary["rolloutStateCounts"] {
  return SOURCE_CONTEXT_WAKE_ROLLOUT_STATES.map((rolloutState) => ({
    rolloutState,
    count: entries.filter((entry) => entry.rolloutState === rolloutState).length,
  }));
}

function countRolloutWaves(
  entries: readonly SourceContextWakeRegistryEntry[],
): SourceContextWakeRegistrySummary["rolloutWaveCounts"] {
  return SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES.map((rolloutWave) => ({
    rolloutWave,
    count: entries.filter((entry) => entry.rolloutWave === rolloutWave).length,
  }));
}
