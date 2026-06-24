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

export type DatabasePoolPressure = Readonly<{
  databasePoolMax: number;
  poolCount: number;
  totalClients: number | null;
  idleClients: number | null;
  activeClients: number | null;
  waitingClients: number | null;
  saturatedPoolCount: number | null;
  waitingPoolCount: number | null;
  pools: readonly DatabasePoolPressurePool[];
}>;

export type DatabasePoolPressurePool = Readonly<{
  names: readonly string[];
  totalClients: number | null;
  idleClients: number | null;
  activeClients: number | null;
  waitingClients: number | null;
  saturated: boolean | null;
  waiting: boolean | null;
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

export function summarizeDatabasePoolPressure(
  databasePoolMax: number,
  poolsByName: Readonly<Record<string, unknown>>,
): DatabasePoolPressure {
  const pools = uniquePoolEntries(poolsByName).map(({ names, pool }): DatabasePoolPressurePool => {
    const totalClients = readPoolCounter(pool, "totalCount");
    const idleClients = readPoolCounter(pool, "idleCount");
    const waitingClients = readPoolCounter(pool, "waitingCount");
    const activeClients =
      totalClients === null || idleClients === null ? null : Math.max(0, totalClients - idleClients);

    return {
      names,
      totalClients,
      idleClients,
      activeClients,
      waitingClients,
      saturated:
        totalClients === null || idleClients === null ? null : totalClients >= databasePoolMax && idleClients === 0,
      waiting: waitingClients === null ? null : waitingClients > 0,
    };
  });

  return {
    databasePoolMax,
    poolCount: pools.length,
    totalClients: sumKnown(pools.map((pool) => pool.totalClients)),
    idleClients: sumKnown(pools.map((pool) => pool.idleClients)),
    activeClients: sumKnown(pools.map((pool) => pool.activeClients)),
    waitingClients: sumKnown(pools.map((pool) => pool.waitingClients)),
    saturatedPoolCount: countKnown(pools.map((pool) => pool.saturated)),
    waitingPoolCount: countKnown(pools.map((pool) => pool.waiting)),
    pools,
  };
}

function normalizeCount(value: number | undefined): number {
  return Math.max(0, Math.floor(value ?? 0));
}

function normalizeSharedRunnerCount(group: WorkerCapacityGroup): number {
  return normalizeCount(group.sharedRunnerCount ?? group.runnerCount - normalizeCount(group.reservedRunnerCount));
}

function uniquePoolEntries(
  poolsByName: Readonly<Record<string, unknown>>,
): readonly Readonly<{ names: readonly string[]; pool: object }>[] {
  const entries: Array<{ names: string[]; pool: object }> = [];

  for (const [name, pool] of Object.entries(poolsByName)) {
    if (typeof pool !== "object" || pool === null) {
      continue;
    }

    const existing = entries.find((entry) => entry.pool === pool);
    if (existing) {
      existing.names.push(name);
      continue;
    }

    entries.push({ names: [name], pool });
  }

  return entries.map((entry) => ({
    names: entry.names.sort((left, right) => left.localeCompare(right)),
    pool: entry.pool,
  }));
}

function readPoolCounter(pool: object, property: "totalCount" | "idleCount" | "waitingCount"): number | null {
  const value = (pool as Record<typeof property, unknown>)[property];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.every((value) => value !== null) ? values.reduce((total, value) => total + value, 0) : null;
}

function countKnown(values: readonly (boolean | null)[]): number | null {
  return values.every((value) => value !== null) ? values.filter(Boolean).length : null;
}
