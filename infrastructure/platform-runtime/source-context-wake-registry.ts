import {
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  type PostgresEventStoreWakeNotificationConfig,
} from "@chase-sets/event-core-postgres";

import type { WorkSignalPriorityLane } from "./work-signal-store";

export const SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION = 1;

export const SOURCE_CONTEXT_WAKE_ROLLOUT_STATES = [
  "not-eligible",
  "eligible",
  "staging-enabled",
  "production-proof",
  "production-enabled",
  "disabled",
  "opted-out",
] as const;

export const SOURCE_CONTEXT_WAKE_PHASES = [
  "phase-1-checkout-hot-path",
  "phase-2-composite-migration",
  "phase-3-expansion",
] as const;

export const SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES = [
  "wave-1-checkout-hot-path",
  "wave-2-commerce-dependencies",
  "wave-3-platform-expansion",
  "wave-4-deferred-or-not-eligible",
] as const;

export const SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES = ["none", "low", "medium", "high", "unknown"] as const;

export const SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES = [1243, 1244, 1246, 1249] as const;

const PHASE_1_REQUIRED_ISSUES = [
  1217, 1219, 1220, 1221, 1222, 1223, 1225, 1226, 1227, 1231, 1237, 1239, 1240, 1242, 1243, 1244, 1245, 1246, 1249,
] as const;
const PHASE_2_REQUIRED_ISSUES = [1217, 1224, 1232, 1238, 1243, 1244, 1245, 1246, 1248, 1249] as const;
const PHASE_3_REQUIRED_ISSUES = [1217, 1230, 1233, 1234, 1243, 1244, 1245, 1246, 1249] as const;

export type SourceContextWakePhase = (typeof SOURCE_CONTEXT_WAKE_PHASES)[number];
export type SourceContextWakeRolloutState = (typeof SOURCE_CONTEXT_WAKE_ROLLOUT_STATES)[number];
export type SourceContextWakeRolloutWave = (typeof SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES)[number];
export type SourceContextWakeLoadEstimate = (typeof SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES)[number];

export type SourceContextWakeEnablement = Readonly<{
  eventStoreWakeNotifications: boolean;
  relayFanOut: boolean;
}>;

export type SourceContextWakeRegistryEntry = Readonly<{
  schemaVersion: typeof SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION;
  sourceContextName: string;
  owner: string;
  rolloutState: SourceContextWakeRolloutState;
  phase: SourceContextWakePhase;
  rolloutWave: SourceContextWakeRolloutWave;
  priorityLane: WorkSignalPriorityLane;
  expectedEventVolume: SourceContextWakeLoadEstimate;
  wakeStoreLoadEstimate: SourceContextWakeLoadEstimate;
  affectedProjectionNames: readonly string[];
  routeDependencyIds: readonly string[];
  requiredIssueNumbers: readonly number[];
  productionEvidenceIssueNumbers: readonly number[];
  enablement: SourceContextWakeEnablement;
  disabledReason?: string;
  optOutReason?: string;
}>;

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

export const sourceContextWakeRegistry = [
  registryEntry({
    sourceContextName: "auth",
    owner: "Auth",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "catalog",
    owner: "Catalog",
    rolloutState: "eligible",
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "checkout:checkout-catalog-item-projection",
      "discovery:discovery-category-projection",
      "discovery:discovery-google-shopping-feed-row-projection",
      "discovery:discovery-item-detail-projection",
      "discovery:discovery-search-item-projection",
      "inventory:inventory-catalog-item-projection",
      "marketplace:marketplace-catalog-item-projection",
      "pricing:pricing-catalog-input-projection",
    ],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "checkout",
    owner: "Checkout",
    // Staging-enabled wave-1 hot path (with marketplace/ordering/payments):
    // staging runs the full push loop, while production stays inert through
    // the relay and event-store wake emission kill switches until the
    // production proof gates pass.
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-1-checkout-hot-path",
    rolloutWave: "wave-1-checkout-hot-path",
    priorityLane: "hot",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "medium",
    affectedProjectionNames: [
      "checkout:checkout.cart-projection",
      "checkout:checkout.sell-list-projection",
      "checkout:checkout.session-projection",
    ],
    routeDependencyIds: [
      "checkout.cart-self-refresh",
      "checkout.guest-sell-list-to-checkout",
      "checkout.sell-list-self-refresh",
      "checkout.session-offer-handoff",
      "checkout.session-payment-handoff",
      "checkout.session-self-refresh",
      "checkout.session-start-to-detail",
    ],
  }),
  registryEntry({
    sourceContextName: "commercial-terms",
    owner: "Commercial Terms",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "discovery",
    owner: "Discovery",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: ["discovery:discovery-product-alert-page-projection"],
    routeDependencyIds: ["discovery.item-detail-checkout-handoff"],
  }),
  registryEntry({
    sourceContextName: "experience",
    owner: "Experience",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "fulfillment",
    owner: "Fulfillment",
    rolloutState: "eligible",
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "medium",
    affectedProjectionNames: [
      "notifications:notifications-source-facts-outbox-projection",
      "ordering:ordering-fulfillment-cancellation-inputs",
      "pricing:pricing-fulfillment-input-projection",
      "reputation:reputation-shipment-source-projection",
      "settlement:settlement-fulfillment-source-projection",
      "support:support-shipment-source-projection",
    ],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "identity",
    owner: "Identity",
    rolloutState: "eligible",
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "standard",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "auth:auth-identity-account-projection",
      "auth:auth-identity-invitation-projection",
      "auth:auth-identity-membership-projection",
      "auth:auth-identity-user-projection",
      "commercial-terms:commercial-terms-account-projection",
      "discovery:discovery-market-projection",
      "fulfillment:fulfillment-account-projection",
      "marketplace:marketplace-identity-account-projection",
      "ordering:ordering-account-projection",
      "reputation:reputation-account-projection",
      "settlement:settlement-account-risk-source-projection",
    ],
    routeDependencyIds: ["identity.shipping-addresses-self-refresh"],
  }),
  registryEntry({
    sourceContextName: "insights",
    owner: "Insights",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "unknown",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "inventory",
    owner: "Inventory",
    rolloutState: "eligible",
    phase: "phase-2-composite-migration",
    rolloutWave: "wave-2-commerce-dependencies",
    priorityLane: "hot",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "inventory:inventory-hold-projection",
      "inventory:inventory-item-projection",
      "inventory:inventory-storage-location-projection",
      "marketplace:marketplace-inventory-supply-projection",
      "ordering:ordering-inventory-reservation-outcomes",
      "ordering:ordering-inventory-supply-input-projection",
      "pricing:pricing-inventory-input-projection",
    ],
    routeDependencyIds: ["inventory.import-batch-detail", "inventory.item-adjust-to-detail"],
  }),
  registryEntry({
    sourceContextName: "marketplace",
    owner: "Marketplace",
    // Wave-1 remainder, staging-enabled after checkout's staging push-loop
    // evidence (push-wake-slo-load-proof.md). Production stays inert via the
    // environment kill switches; the wave-1 listener URLs and connection
    // budget already cover this context (locals.tf).
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-1-checkout-hot-path",
    rolloutWave: "wave-1-checkout-hot-path",
    priorityLane: "hot",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "discovery:discovery-market-projection",
      "discovery:discovery-product-alert-notification-projection",
      "marketplace:marketplace-listing-projection",
      "marketplace:marketplace-offer-projection",
      "ordering:ordering-marketplace-offer-acceptance",
      "ordering:ordering-marketplace-supply-input-projection",
      "pricing:pricing-market-input-projection",
    ],
    routeDependencyIds: [
      "marketplace.listing-create-to-detail",
      "marketplace.listing-list-self-refresh",
      "marketplace.submitted-offer-detail",
    ],
  }),
  registryEntry({
    sourceContextName: "notifications",
    owner: "Notifications",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "ordering",
    owner: "Ordering",
    // Wave-1 remainder, staging-enabled; see the marketplace entry note.
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-1-checkout-hot-path",
    rolloutWave: "wave-1-checkout-hot-path",
    priorityLane: "hot",
    expectedEventVolume: "high",
    wakeStoreLoadEstimate: "high",
    affectedProjectionNames: [
      "fulfillment:fulfillment-order-source-projection",
      "inventory:inventory-order-reservation-workflow",
      "notifications:notifications-source-facts-outbox-projection",
      "ordering:ordering-postage-policy-projection",
      "payments:payments-order-cancellation-refund-effect",
      "payments:payments-order-input-projection",
      "pricing:pricing-order-input-projection",
      "reputation:reputation-order-source-projection",
      "support:support-order-source-projection",
    ],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "payments",
    owner: "Payments",
    // Wave-1 remainder, staging-enabled; see the marketplace entry note.
    rolloutState: "staging-enabled",
    enablement: {
      eventStoreWakeNotifications: true,
      relayFanOut: true,
    },
    phase: "phase-1-checkout-hot-path",
    rolloutWave: "wave-1-checkout-hot-path",
    priorityLane: "hot",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "medium",
    affectedProjectionNames: [
      "ordering:ordering-payment-capture",
      "payments:payments-payment-projection",
      "settlement:settlement-payment-input-projection",
    ],
    routeDependencyIds: ["payments.create-to-detail", "payments.detail-self-refresh"],
  }),
  registryEntry({
    sourceContextName: "platform-operations",
    owner: "Platform Operations",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "pricing",
    owner: "Pricing",
    rolloutState: "not-eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-4-deferred-or-not-eligible",
    priorityLane: "bulk",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "none",
    affectedProjectionNames: [],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "public-presence",
    owner: "Public Presence",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "bulk",
    expectedEventVolume: "low",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: [
      "public-presence:public-presence-waitlist-projection",
      "public-presence:public-presence-waitlist-transactional-email-projection",
    ],
    routeDependencyIds: [],
  }),
  registryEntry({
    sourceContextName: "reputation",
    owner: "Reputation",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: [
      "discovery:discovery-market-projection",
      "marketplace:marketplace-identity-account-projection",
      "settlement:settlement-account-risk-source-projection",
    ],
    routeDependencyIds: ["reputation.review-submit-to-detail"],
  }),
  registryEntry({
    sourceContextName: "settlement",
    owner: "Settlement",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: [],
    routeDependencyIds: ["settlement.payout-request-to-detail"],
  }),
  registryEntry({
    sourceContextName: "support",
    owner: "Support",
    rolloutState: "eligible",
    phase: "phase-3-expansion",
    rolloutWave: "wave-3-platform-expansion",
    priorityLane: "standard",
    expectedEventVolume: "medium",
    wakeStoreLoadEstimate: "low",
    affectedProjectionNames: [
      "payments:payments-support-refund-effect",
      "reputation:reputation-support-source-projection",
      "settlement:settlement-support-hold-projection",
    ],
    routeDependencyIds: [],
  }),
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

export function getSourceContextWakeRegistryEntry(
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

export function createEventStoreWakeNotificationConfigForSourceContext(
  input: SourceContextWakeNotificationConfigInput,
): PostgresEventStoreWakeNotificationConfig {
  const entry = requireSourceContextWakeRegistryEntry(input.sourceContextName, input.registry);
  validateSourceContextWakeRegistryEntry(entry);

  return {
    enabled: entry.enablement.eventStoreWakeNotifications && isEventStoreWakeNotificationEmissionEnabled(),
    channel: input.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
    source: input.source ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
    ...(input.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: input.maxPayloadBytes }),
  };
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

export function isSourceContextWakeActive(entry: Pick<SourceContextWakeRegistryEntry, "rolloutState">): boolean {
  return (
    entry.rolloutState === "staging-enabled" ||
    entry.rolloutState === "production-proof" ||
    entry.rolloutState === "production-enabled"
  );
}

function registryEntry(
  input: Omit<
    SourceContextWakeRegistryEntry,
    "schemaVersion" | "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement"
  > &
    Partial<
      Pick<SourceContextWakeRegistryEntry, "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement">
    >,
): SourceContextWakeRegistryEntry {
  return {
    schemaVersion: SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION,
    ...input,
    affectedProjectionNames: sortUnique(input.affectedProjectionNames),
    routeDependencyIds: sortUnique(input.routeDependencyIds),
    requiredIssueNumbers: sortUniqueNumbers([
      ...phaseRequiredIssueNumbers(input.phase),
      ...(input.requiredIssueNumbers ?? []),
    ]),
    productionEvidenceIssueNumbers: sortUniqueNumbers([
      ...SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES,
      ...(input.productionEvidenceIssueNumbers ?? []),
    ]),
    enablement: input.enablement ?? {
      eventStoreWakeNotifications: false,
      relayFanOut: false,
    },
  };
}

function phaseRequiredIssueNumbers(phase: SourceContextWakePhase): readonly number[] {
  if (phase === "phase-1-checkout-hot-path") {
    return PHASE_1_REQUIRED_ISSUES;
  }
  if (phase === "phase-2-composite-migration") {
    return PHASE_2_REQUIRED_ISSUES;
  }
  return PHASE_3_REQUIRED_ISSUES;
}

function validateSourceContextWakeRegistryEntry(entry: SourceContextWakeRegistryEntry): void {
  assertNonEmptyText(entry.sourceContextName, "sourceContextName");
  assertNonEmptyText(entry.owner, `${entry.sourceContextName}.owner`);

  if (entry.schemaVersion !== SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has unsupported schemaVersion ${entry.schemaVersion}.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_ROLLOUT_STATES.includes(entry.rolloutState)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid rolloutState '${entry.rolloutState}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_PHASES.includes(entry.phase)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid phase '${entry.phase}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_ROLLOUT_WAVES.includes(entry.rolloutWave)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid rolloutWave '${entry.rolloutWave}'.`,
    );
  }

  if (!["hot", "standard", "bulk"].includes(entry.priorityLane)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid priorityLane '${entry.priorityLane}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES.includes(entry.expectedEventVolume)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid expectedEventVolume '${entry.expectedEventVolume}'.`,
    );
  }

  if (!SOURCE_CONTEXT_WAKE_LOAD_ESTIMATES.includes(entry.wakeStoreLoadEstimate)) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' has invalid wakeStoreLoadEstimate '${entry.wakeStoreLoadEstimate}'.`,
    );
  }

  assertUniqueStrings(entry.affectedProjectionNames, `${entry.sourceContextName}.affectedProjectionNames`);
  assertUniqueStrings(entry.routeDependencyIds, `${entry.sourceContextName}.routeDependencyIds`);
  assertUniqueNumbers(entry.requiredIssueNumbers, `${entry.sourceContextName}.requiredIssueNumbers`);
  assertUniqueNumbers(
    entry.productionEvidenceIssueNumbers,
    `${entry.sourceContextName}.productionEvidenceIssueNumbers`,
  );

  if (entry.enablement.relayFanOut && !entry.enablement.eventStoreWakeNotifications) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' cannot enable relay fan-out without event-store wake notifications.`,
    );
  }

  if (
    (entry.enablement.eventStoreWakeNotifications || entry.enablement.relayFanOut) &&
    !isSourceContextWakeActive(entry)
  ) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' cannot enable runtime wake behavior while rolloutState is '${entry.rolloutState}'.`,
    );
  }

  if (isSourceContextWakeActive(entry)) {
    if (!entry.enablement.eventStoreWakeNotifications || !entry.enablement.relayFanOut) {
      throw new Error(
        `Source-context wake registry entry '${entry.sourceContextName}' has active rolloutState '${entry.rolloutState}' but runtime enablement is incomplete.`,
      );
    }
  }

  if (entry.rolloutState === "production-proof" || entry.rolloutState === "production-enabled") {
    const missingGateIssues = SOURCE_CONTEXT_WAKE_PRODUCTION_GATE_ISSUES.filter(
      (issueNumber) => !entry.productionEvidenceIssueNumbers.includes(issueNumber),
    );
    if (missingGateIssues.length > 0) {
      throw new Error(
        `Source-context wake registry entry '${entry.sourceContextName}' is missing production gate issue(s): ${missingGateIssues.join(
          ", ",
        )}.`,
      );
    }
  }

  if (entry.rolloutState === "disabled" && !entry.disabledReason?.trim()) {
    throw new Error(`Source-context wake registry entry '${entry.sourceContextName}' is disabled without a reason.`);
  }

  if (entry.rolloutState !== "disabled" && entry.disabledReason) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' declares disabledReason while rolloutState is '${entry.rolloutState}'.`,
    );
  }

  if (entry.rolloutState === "opted-out" && !entry.optOutReason?.trim()) {
    throw new Error(`Source-context wake registry entry '${entry.sourceContextName}' is opted out without a reason.`);
  }

  if (entry.rolloutState !== "opted-out" && entry.optOutReason) {
    throw new Error(
      `Source-context wake registry entry '${entry.sourceContextName}' declares optOutReason while rolloutState is '${entry.rolloutState}'.`,
    );
  }
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

function assertNonEmptyText(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`Source-context wake registry field '${fieldName}' is required.`);
  }
}

function assertUniqueStrings(values: readonly string[], fieldName: string): void {
  for (const value of values) {
    assertNonEmptyText(value, fieldName);
  }

  const duplicates = duplicatesOf(values);
  if (duplicates.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains duplicate value(s): ${duplicates.join(", ")}.`,
    );
  }
}

function assertUniqueNumbers(values: readonly number[], fieldName: string): void {
  const duplicates = duplicatesOf(values);
  if (duplicates.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains duplicate value(s): ${duplicates.join(", ")}.`,
    );
  }

  const invalid = values.filter((value) => !Number.isInteger(value) || value < 1);
  if (invalid.length > 0) {
    throw new Error(
      `Source-context wake registry field '${fieldName}' contains invalid issue number(s): ${invalid.join(", ")}.`,
    );
  }
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortUniqueNumbers(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function duplicatesOf<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
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
