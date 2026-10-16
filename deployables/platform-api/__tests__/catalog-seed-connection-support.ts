import type { Pool } from "pg";

export type CatalogSeedBackend = Readonly<{
  datname: string;
  pid: number;
  application_name: string | null;
  backend_type: string | null;
  state: string | null;
}>;

function backendPid(client: object): number {
  const pid: unknown = Reflect.get(client, "processID");
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    throw new Error("Catalog seed connection tracking requires a PostgreSQL backend PID.");
  }
  return pid;
}

export function trackCatalogSeedConnections(namedPools: Readonly<Record<string, Pool>>) {
  const pools = [...new Set(Object.values(namedPools))];
  const owners = new Map<number, Readonly<{ pools: readonly string[]; removed: boolean }>>();
  for (const pool of pools) {
    const names = Object.keys(namedPools).filter((name) => namedPools[name] === pool);
    pool.on("connect", (client) => {
      owners.set(backendPid(client), { pools: names, removed: false });
    });
    // A removed client has been closed by the harness, even if PostgreSQL has
    // not yet processed its disconnect. Retain its ownership for diagnostics.
    pool.on("remove", (client) => {
      owners.set(backendPid(client), { pools: names, removed: true });
    });
  }

  return (backends: readonly CatalogSeedBackend[]) => {
    const poolStates = pools.map((pool) => ({
      names: Object.keys(namedPools).filter((name) => namedPools[name] === pool),
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }));
    const connections = backends.map((backend) => ({
      ...backend,
      owner: owners.get(backend.pid) ?? null,
    }));
    const unexpected = connections.filter(
      (backend) =>
        !backend.backend_type ||
        (backend.backend_type === "client backend" &&
          (!backend.owner?.pools.includes("catalog") || backend.state !== "idle")),
    );
    const busy = poolStates.filter((pool) => pool.total !== pool.idle || pool.waiting !== 0);
    const observedPids = new Set(backends.map(({ pid }) => pid));
    const missing = [...owners].filter(([pid, owner]) => !owner.removed && !observedPids.has(pid));
    return { connections, poolStates, unexpected, busy, missing };
  };
}
