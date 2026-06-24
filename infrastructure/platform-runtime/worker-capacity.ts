export type WorkerCapacityGroup = Readonly<{
  name: string;
  runnerCount: number;
  maxConcurrentRunners: number;
  reservedRunnerSlots?: number;
  reservedRunnerCount?: number;
  sharedRunnerCount?: number;
}>;

export type WorkerRunnerCapacity = Readonly<{
  databasePoolMax: number;
  configuredRunnerConcurrency: number;
  reservedRunnerSlots: number;
  overPoolCapacity: boolean;
  runnerGroups: Record<
    string,
    Readonly<{
      runnerCount: number;
      maxConcurrentRunners: number;
      reservedRunnerSlots: number;
      reservedRunnerCount: number;
      sharedRunnerCount: number;
    }>
  >;
}>;

export function summarizeRunnerCapacity(
  databasePoolMax: number,
  groups: readonly WorkerCapacityGroup[],
): WorkerRunnerCapacity {
  const configuredRunnerConcurrency = groups.reduce((total, group) => total + group.maxConcurrentRunners, 0);
  const reservedRunnerSlots = groups.reduce((total, group) => total + normalizeCount(group.reservedRunnerSlots), 0);

  return {
    databasePoolMax,
    configuredRunnerConcurrency,
    reservedRunnerSlots,
    overPoolCapacity: configuredRunnerConcurrency > databasePoolMax,
    runnerGroups: Object.fromEntries(
      groups.map((group) => [
        group.name,
        {
          runnerCount: group.runnerCount,
          maxConcurrentRunners: group.maxConcurrentRunners,
          reservedRunnerSlots: normalizeCount(group.reservedRunnerSlots),
          reservedRunnerCount: normalizeCount(group.reservedRunnerCount),
          sharedRunnerCount: normalizeSharedRunnerCount(group),
        },
      ]),
    ),
  };
}

export function assertRunnerCapacity(
  capacity: WorkerRunnerCapacity,
  input: Readonly<{
    workerName: string;
    allowOverPoolCapacity?: boolean;
  }>,
): void {
  if (!capacity.overPoolCapacity || input.allowOverPoolCapacity) {
    return;
  }

  throw new Error(
    `${input.workerName} runner concurrency (${capacity.configuredRunnerConcurrency}) exceeds DATABASE_POOL_MAX (${capacity.databasePoolMax}). Lower WORKER_*_MAX_CONCURRENT_RUNNERS or set ALLOW_WORKER_OVER_POOL_CAPACITY=true for local testing only.`,
  );
}

export function assertRunnerLaneIsolation(
  capacity: WorkerRunnerCapacity,
  input: Readonly<{
    workerName: string;
  }>,
): void {
  for (const [groupName, group] of Object.entries(capacity.runnerGroups)) {
    if (group.reservedRunnerSlots > 0 && group.reservedRunnerCount === 0) {
      throw new Error(
        `${input.workerName} runner group '${groupName}' reserves ${group.reservedRunnerSlots} slot(s) but has no reserved-capacity runners.`,
      );
    }

    if (group.reservedRunnerCount > 0 && group.reservedRunnerSlots === 0) {
      throw new Error(
        `${input.workerName} runner group '${groupName}' has ${group.reservedRunnerCount} reserved-capacity runner(s) but reserves no slots.`,
      );
    }

    if (group.reservedRunnerSlots > group.reservedRunnerCount) {
      throw new Error(
        `${input.workerName} runner group '${groupName}' reserves ${group.reservedRunnerSlots} slot(s) for ${group.reservedRunnerCount} reserved-capacity runner(s).`,
      );
    }

    const requiredSlots = group.reservedRunnerSlots + (group.sharedRunnerCount > 0 ? 1 : 0);
    if (requiredSlots > group.maxConcurrentRunners) {
      throw new Error(
        `${input.workerName} runner group '${groupName}' must allow ${requiredSlots} concurrent runner(s) to keep ${group.reservedRunnerSlots} reserved slot(s) isolated from shared work.`,
      );
    }
  }
}

function normalizeCount(value: number | undefined): number {
  return Math.max(0, Math.floor(value ?? 0));
}

function normalizeSharedRunnerCount(group: WorkerCapacityGroup): number {
  return normalizeCount(group.sharedRunnerCount ?? group.runnerCount - normalizeCount(group.reservedRunnerCount));
}
