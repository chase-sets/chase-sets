export type WorkerCapacityGroup = Readonly<{
  name: string;
  runnerCount: number;
  maxConcurrentRunners: number;
}>;

export type WorkerRunnerCapacity = Readonly<{
  databasePoolMax: number;
  configuredRunnerConcurrency: number;
  overPoolCapacity: boolean;
  runnerGroups: Record<string, Readonly<{ runnerCount: number; maxConcurrentRunners: number }>>;
}>;

export function summarizeRunnerCapacity(
  databasePoolMax: number,
  groups: readonly WorkerCapacityGroup[],
): WorkerRunnerCapacity {
  const configuredRunnerConcurrency = groups.reduce((total, group) => total + group.maxConcurrentRunners, 0);

  return {
    databasePoolMax,
    configuredRunnerConcurrency,
    overPoolCapacity: configuredRunnerConcurrency > databasePoolMax,
    runnerGroups: Object.fromEntries(
      groups.map((group) => [
        group.name,
        {
          runnerCount: group.runnerCount,
          maxConcurrentRunners: group.maxConcurrentRunners,
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
