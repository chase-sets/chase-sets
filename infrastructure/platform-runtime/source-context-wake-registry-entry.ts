import type { WorkSignalPriorityLane } from "./work-signal-store";

const SOURCE_CONTEXT_WAKE_REGISTRY_SCHEMA_VERSION = 1;

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

export type SourceContextWakeRegistryEntryInput = Omit<
  SourceContextWakeRegistryEntry,
  "schemaVersion" | "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement"
> &
  Partial<
    Pick<SourceContextWakeRegistryEntry, "requiredIssueNumbers" | "productionEvidenceIssueNumbers" | "enablement">
  >;

/**
 * Builds one registry entry from a per-context shard module. Every shard in
 * `./source-context-wake-registry/` calls this so schema version, phase-derived
 * issue gates, enablement defaults, and list normalization stay identical
 * across contexts; the aggregate composes the built entries in order.
 */
export function registryEntry(input: SourceContextWakeRegistryEntryInput): SourceContextWakeRegistryEntry {
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

export function isSourceContextWakeActive(entry: Pick<SourceContextWakeRegistryEntry, "rolloutState">): boolean {
  return (
    entry.rolloutState === "staging-enabled" ||
    entry.rolloutState === "production-proof" ||
    entry.rolloutState === "production-enabled"
  );
}

export function validateSourceContextWakeRegistryEntry(entry: SourceContextWakeRegistryEntry): void {
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
