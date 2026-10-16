import pg from "pg";
import { describe, expect, it } from "vitest";
import { trackCatalogSeedConnections, type CatalogSeedBackend } from "./catalog-seed-connection-support";

function backend(pid: number, overrides: Partial<CatalogSeedBackend> = {}): CatalogSeedBackend {
  return {
    datname: "synthetic_catalog",
    pid,
    application_name: "synthetic-catalog-seed",
    backend_type: "client backend",
    state: "idle",
    ...overrides,
  };
}

describe("catalog seed connection ownership", () => {
  it("distinguishes a PostgreSQL worker from a leaking seed-host client at the same physical count", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ catalog: pool, "catalog:waiter": pool });
    const client = Object.assign(new pg.Client(), { processID: 101 });
    pool.emit("connect", client);
    const worker = backend(102, { application_name: "", backend_type: "autovacuum worker", state: "active" });
    const clean = inspect([backend(101), worker]);
    expect(clean.unexpected).toEqual([]);
    expect(clean.busy).toEqual([]);
    expect(clean.missing).toEqual([]);
    expect(clean.connections[0]?.owner?.pools).toEqual(["catalog", "catalog:waiter"]);

    const leaked = backend(102, { application_name: "synthetic-seed-host-leak" });
    expect(inspect([backend(101), leaked]).unexpected).toEqual([{ ...leaked, owner: null }]);
  });

  it("retains ownership of a harness-closed backend until PostgreSQL processes its disconnect", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ catalog: pool });
    const client = Object.assign(new pg.Client(), { processID: 101 });
    pool.emit("connect", client);
    pool.emit("remove", client);
    expect(inspect([backend(101)]).connections[0]?.owner).toEqual({ pools: ["catalog"], removed: true });
    expect(inspect([backend(101)]).unexpected).toEqual([]);
    expect(inspect([]).missing).toEqual([]);
  });

  it("rejects unknown metadata, another context's client and missing registered clients", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ identity: pool });
    pool.emit("connect", Object.assign(new pg.Client(), { processID: 101 }));
    expect(inspect([backend(101)]).unexpected).toHaveLength(1);
    expect(inspect([backend(102, { backend_type: null })]).unexpected).toHaveLength(1);
    expect(inspect([]).missing).toEqual([[101, { pools: ["identity"], removed: false }]]);
  });

  it("rejects checked-out clients and pending borrowers even when every backend is registered", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ catalog: pool });
    pool.emit("connect", Object.assign(new pg.Client(), { processID: 101 }));
    Object.defineProperties(pool, {
      totalCount: { value: 1 },
      idleCount: { value: 0 },
      waitingCount: { value: 1 },
    });
    const snapshot = inspect([backend(101)]);
    expect(snapshot.unexpected).toEqual([]);
    expect(snapshot.busy).toEqual([{ names: ["catalog"], total: 1, idle: 0, waiting: 1 }]);
  });

  it("rejects an open transaction even if its client was returned to the seed's pool", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ catalog: pool });
    pool.emit("connect", Object.assign(new pg.Client(), { processID: 101 }));
    expect(inspect([backend(101, { state: "idle in transaction" })]).unexpected).toHaveLength(1);
  });

  it("accepts two registered idle clients without accepting a third unregistered client", () => {
    const pool = new pg.Pool();
    const inspect = trackCatalogSeedConnections({ catalog: pool });
    pool.emit("connect", Object.assign(new pg.Client(), { processID: 101 }));
    pool.emit("connect", Object.assign(new pg.Client(), { processID: 102 }));
    Object.defineProperties(pool, { totalCount: { value: 2 }, idleCount: { value: 2 } });
    const clean = inspect([backend(101), backend(102)]);
    expect(clean.unexpected).toEqual([]);
    expect(clean.busy).toEqual([]);
    expect(clean.missing).toEqual([]);
    expect(inspect([backend(101), backend(102), backend(103)]).unexpected).toHaveLength(1);
  });
});
