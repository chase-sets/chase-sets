import type { Pool } from "pg";

export type CatalogSeedBackend = Readonly<{
  datname: string;
  pid: number;
  usename: string | null;
  application_name: string | null;
  backend_type: string | null;
  state: string | null;
  backend_start: Date | string | null;
}>;

const SERVER_BACKEND_TYPES = new Set([
  "archiver",
  "autovacuum launcher",
  "autovacuum worker",
  "background writer",
  "checkpointer",
  "logical replication launcher",
  "parallel worker",
  "startup",
  "walreceiver",
  "walwriter",
]);

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
    const unexpected = connections.filter((backend) => {
      if (backend.backend_type === "client backend") {
        return !backend.owner?.pools.includes("catalog") || backend.state !== "idle";
      }
      return !backend.backend_type || !SERVER_BACKEND_TYPES.has(backend.backend_type);
    });
    const busy = poolStates.filter((pool) => pool.total !== pool.idle || pool.waiting !== 0);
    const missing = poolStates
      .map((pool) => ({
        ...pool,
        observed: connections.filter(
          (backend) =>
            backend.owner && !backend.owner.removed && backend.owner.pools.some((name) => pool.names.includes(name)),
        ).length,
      }))
      .filter((pool) => pool.observed < pool.total);
    return { connections, poolStates, unexpected, busy, missing };
  };
}
