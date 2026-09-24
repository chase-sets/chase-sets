import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { seedApiHostIfEmpty, type ApiContextRegistry, type ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import { describe, expect, it } from "vitest";
import { closePlatformApiPools, createSeedCommandPools, selectSeedCommandDatabaseConfig } from "../src/database-pools";
import { getPlatformApiContextsForRuntimeProfile, type PlatformApiBaseConfig } from "../src/config";

const pooledConfig: PlatformApiBaseConfig = {
  runtimeProfile: "public",
  deploymentEnvironment: "staging",
  sharedDatabaseUrl: null,
  controlDatabaseUrl: "postgres://runtime@host:25061/control",
  contextDatabaseUrls: { auth: "postgres://runtime@host:25061/auth" },
  port: 8080,
};

describe("in-pod seed command database selection", () => {
  it("bootstraps through the real one-connection seed pools without starving the lock context", async () => {
    const contexts = getPlatformApiContextsForRuntimeProfile("public");
    const pools = createSeedCommandPools({
      ...pooledConfig,
      pool: { max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 500 },
      controlDatabaseUrl: "postgres://synthetic.invalid:25060/control",
      contextDatabaseUrls: Object.fromEntries(
        contexts.map((name) => [name, `postgres://synthetic.invalid:25060/${name}`]),
      ),
    });
    class MemoryClient extends EventEmitter {
      connect(callback: (error?: Error) => void) { callback(); }
      query(_sql: string, values?: unknown, callback?: (error: Error | null, result: unknown) => void) {
        const result = { rows: _sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [] };
        const done = typeof values === "function" ? values : callback;
        if (done) { (done as (error: null, result: unknown) => void)(null, result); return; }
        return Promise.resolve(result);
      }
      end() { this.emit("end"); }
    }
    for (const pool of new Set([...contexts.map((name) => pools[name]), pools.control, pools.schemaBootstrapLockPool])) {
      (pool as unknown as { Client: typeof MemoryClient }).Client = MemoryClient;
    }
    const module = { contextName: "auth", streamPrefix: "auth.", schemaSql: "", schemaMigrations: [] };
    const registry = [{
      contextName: "auth", packageName: "@test/auth",
      manifest: { contextName: "auth", apiDeployables: ["platform-api"] }, module,
    }] as unknown as ApiContextRegistry;
    const runtime = {
      mountedContexts: [{ contextName: "auth", pool: pools.auth, module, mountRole: "active", services: {}, projectionHandlerSets: [] }],
    } as unknown as ApiHostRuntime;
    try {
      await seedApiHostIfEmpty(registry, "platform-api", runtime, {
        enabledDataProfiles: ["critical-bootstrap"], environmentName: "test", runtimeProfile: "public",
        substepTimeoutMs: 200,
        schemaBootstrapLockPool: pools.schemaBootstrapLockPool,
      });
    } finally {
      await closePlatformApiPools(pools);
    }
  });
  it("caps the aggregate direct seed demand even when the runtime pool max is six", async () => {
    const contexts = getPlatformApiContextsForRuntimeProfile("public");
    const directUrl = (name: string, role = "owner") => `postgres://${role}@host:25060/${name}`;
    const config: PlatformApiBaseConfig = {
      ...pooledConfig,
      pool: { max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000 },
      controlDatabaseUrl: directUrl("control"),
      workSignalDatabaseUrl: directUrl("control"),
      contextDatabaseUrls: Object.fromEntries(contexts.map((name) => [name, directUrl(name)])),
      contextWaiterDatabaseUrls: Object.fromEntries(
        ["catalog", "discovery", "inventory", "marketplace"].map((name) => [name, directUrl(name, "waiter")]),
      ),
    };
    const pools = createSeedCommandPools(config);
    try {
      const uniquePools = new Set([
        ...contexts.map((name) => pools[name]),
        pools.control,
        pools.workSignal,
        pools.schemaBootstrapLockPool,
        ...Object.values(pools.contextWaiters),
      ]);
      const maxConnections = [...uniquePools].reduce(
        (total, pool) => total + (pool as unknown as { options: { max: number } }).options.max,
        0,
      );
      expect(contexts).toHaveLength(20);
      expect(uniquePools.size).toBe(26); // 20 context URLs, control, four distinct waiter URLs, lock holder.
      expect(maxConnections).toBe(26);
      expect(pools.schemaBootstrapLockPool).not.toBe(pools.auth);
      expect((pools.schemaBootstrapLockPool as unknown as { options: { connectionString: string } }).options.connectionString)
        .toBe((pools.auth as unknown as { options: { connectionString: string } }).options.connectionString);
      expect(config.pool?.max).toBe(6);
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("routes both exec entry points through direct pools before the shared schema lock", () => {
    for (const command of ["representative-commerce-state", "admin-qa-actor-fixtures"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${command}.ts`, import.meta.url)), "utf8");
      expect(source).toMatch(/(?:const seedPools = options\.pools \? null : |const pools = )createSeedCommandPools\(config!?\)/);
    }
  });

  it("uses direct bootstrap URLs for the lock context, every schema, and control", () => {
    const env = Object.fromEntries(
      getPlatformApiContextsForRuntimeProfile("landing").map((name) => [
        `BOOTSTRAP_DATABASE_URL_${name.toUpperCase().replaceAll("-", "_")}`,
        `postgres://direct@host:25060/${name}`,
      ]),
    );
    const selected = selectSeedCommandDatabaseConfig(
      { ...pooledConfig, runtimeProfile: "landing" },
      { ...env, BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL: "postgres://direct@host:25060/control" },
    );

    expect(selected.contextDatabaseUrls.auth).toBe("postgres://direct@host:25060/auth");
    for (const name of getPlatformApiContextsForRuntimeProfile("landing")) {
      expect(selected.contextDatabaseUrls[name]).toBe(`postgres://direct@host:25060/${name}`);
    }
    expect(selected.controlDatabaseUrl).toBe("postgres://direct@host:25060/control");
    expect(selected.sharedDatabaseUrl).toBeNull();
  });

  it("fails closed before creating pools if a managed command has no direct URL", () => {
    expect(() => selectSeedCommandDatabaseConfig({ ...pooledConfig, runtimeProfile: "landing" }, {})).toThrowError(
      /SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED.*BOOTSTRAP_DATABASE_URL_AUTH/,
    );
  });

  it("accepts standalone staging jobs whose exported runtime URLs are already direct", () => {
    const directConfig: PlatformApiBaseConfig = {
      ...pooledConfig,
      sharedDatabaseUrl: "postgres://direct@host:25060/shared",
      controlDatabaseUrl: "postgres://direct@host:25060/control",
      contextDatabaseUrls: {},
    };
    const selected = selectSeedCommandDatabaseConfig(directConfig, {});
    expect(selected.contextDatabaseUrls.auth).toBe("postgres://direct@host:25060/shared");
    expect(selected.controlDatabaseUrl).toBe("postgres://direct@host:25060/control");
    expect(selected.sharedDatabaseUrl).toBeNull();
  });

  it("rejects a transaction-pool URL even if mislabeled as bootstrap", () => {
    const env = Object.fromEntries(
      getPlatformApiContextsForRuntimeProfile("landing").map((name) => [
        `BOOTSTRAP_DATABASE_URL_${name.toUpperCase().replaceAll("-", "_")}`,
        `postgres://direct@host:25060/${name}`,
      ]),
    );
    expect(() =>
      selectSeedCommandDatabaseConfig(
        { ...pooledConfig, runtimeProfile: "landing" },
        {
          ...env,
          BOOTSTRAP_DATABASE_URL_AUTH: "postgres://runtime@host:25061/auth",
          BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL: "postgres://direct@host:25060/control",
        },
      ),
    ).toThrowError(/SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED.*BOOTSTRAP_DATABASE_URL_AUTH/);
  });

  it("fails closed for an unrecognized managed-cluster port rather than assuming it is session-safe", () => {
    expect(() =>
      selectSeedCommandDatabaseConfig(
        { ...pooledConfig, runtimeProfile: "landing", contextDatabaseUrls: { auth: "postgres://host:6432/auth" } },
        {},
      ),
    ).toThrowError(/SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED.*BOOTSTRAP_DATABASE_URL_AUTH/);
  });
});
