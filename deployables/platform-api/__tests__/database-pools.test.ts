import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { managedPostgresPodCaPath } from "@chase-sets/event-core-postgres";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { module as authModule } from "@chase-sets/auth";
import type { PricingServices } from "@chase-sets/pricing/server";
import { createPlatformApiHost } from "../src/app";
import type { PlatformApiBaseConfig } from "../src/config";
import {
  PENDING_REGISTRATION_LOCK_POOL_MAX,
  closePlatformApiPools,
  createPendingRegistrationLockPool,
  createPlatformApiPools,
  createPlatformApiRuntimePools,
  runPlatformApiStartup,
} from "../src/database-pools";
import { resolveApiHostMounts } from "@chase-sets/platform-runtime/api";

describe("platform api database pools", () => {
  it("binds the shared pool factory to the platform API host registry", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      workSignalDatabaseUrl: "postgresql://localhost/control-direct",
      contextDatabaseUrls: {
        auth: "postgresql://localhost/auth",
        catalog: "postgresql://localhost/catalog",
        payments: "postgresql://localhost/payments",
      },
      contextWaiterDatabaseUrls: {
        catalog: "postgresql://localhost/catalog-direct",
      },
      port: 6182,
    });

    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
        },
      });

      expect(pools.auth).not.toBe(pools.catalog);
      expect(pools.payments).not.toBe(pools.catalog);
      expect(pools.workSignal).not.toBe(pools.control);
      expect(pools.contextWaiters.catalog).not.toBe(pools.catalog);
      expect(pools.contextWaiters.auth).toBe(pools.auth);
      const options = (
        pools.auth as unknown as {
          options: {
            idle_in_transaction_session_timeout?: number;
            options?: string;
            onConnect: (client: unknown) => Promise<void>;
          };
        }
      ).options;

      expect(options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(options.options).toBeUndefined();
      const client = createFakeClient();
      await options.onConnect(client);
      expect(client.query).toHaveBeenCalledWith("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
        "15000ms",
      ]);
      expect(runtime.mountedContexts.length).toBeGreaterThan(0);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "auth")?.pool).toBe(pools.auth);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "catalog")?.pool).toBe(pools.catalog);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "catalog")?.notificationWaiterPool).toBe(
        pools.contextWaiters.catalog,
      );
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "payments")?.pool).toBe(pools.payments);
      const pricing = runtime.services.pricing as PricingServices;
      expect(pricing.evaluationAuthority?.prepare).toBeTypeOf("function");
    } finally {
      await closePlatformApiPools(pools);
    }
  });

  it("binds landing profile pools to the landing context set", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      contextDatabaseUrls: {},
      port: 6182,
    });

    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools,
        hostPorts: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
      });
      const mountedContextNames = runtime.mountedContexts.map((entry) => entry.contextName);

      expect(mountedContextNames).toEqual([
        "auth",
        "catalog",
        "commercial-terms",
        "fulfillment",
        "identity",
        "marketplace",
        "ordering",
        "platform-operations",
        "public-presence",
        "settlement",
      ]);
      expect(mountedContextNames).not.toContain("checkout");
      expect(mountedContextNames).not.toContain("payments");
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "commercial-terms")?.mountRole).toBe(
        "source-only",
      );
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "settlement")?.mountRole).toBe(
        "source-only",
      );
      const mountedApiPaths = resolveApiHostMounts(runtime).map((mount) => mount.mountPath);
      expect(mountedApiPaths).not.toContain("/api/commercial-terms");
      expect(mountedApiPaths).not.toContain("/api/public/commercial-terms");
      expect(mountedApiPaths).not.toContain("/api/settlement");
      expect(mountedApiPaths).not.toContain("/api/settlement/provider");
    } finally {
      await closePlatformApiPools(pools);
    }
  });
});

describe("Pending Registration lock pool", () => {
  type PoolOptions = { max: number; connectionTimeoutMillis: number; connectionString: string };
  const optionsOf = (pool: unknown) => (pool as { options: PoolOptions }).options;
  const end = (pool: unknown) => (pool as { end: () => Promise<void> }).end();
  // Pod URLs verify TLS against the pod's managed Postgres CA mount.
  const podManagedUrl = (url: string, caPath = managedPostgresPodCaPath) => {
    const managed = new URL(url);
    managed.searchParams.set("sslmode", "verify-full");
    managed.searchParams.set("uselibpqcompat", "true");
    managed.searchParams.set("sslrootcert", caPath);
    return managed.toString();
  };
  const runtimeAuthUrl = podManagedUrl("postgresql://auth_runtime:synthetic-secret@db.example.test:25061/auth_pool");
  const directAuthUrl = podManagedUrl("postgresql://auth_runtime:synthetic-secret@db.example.test:25060/auth");

  beforeEach(() => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.245.0.1");
    vi.stubEnv("GITHUB_ACTIONS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const managed = (environment: "staging" | "production", authUrl = runtimeAuthUrl): PlatformApiBaseConfig => ({
    runtimeProfile: "public",
    sharedDatabaseUrl: null,
    contextDatabaseUrls: { auth: authUrl },
    pool: { max: 40, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 7_000 },
    deploymentEnvironment: environment,
    port: 6182,
  });

  it.each([
    ["the Auth URL", { auth: "postgresql://localhost/auth" }, "postgresql://localhost/shared", "/auth"],
    ["the shared URL", {}, "postgresql://localhost/shared", "/shared"],
  ] as const)(
    "caps a local lock pool on %s at two connections over any pool override",
    async (_, urls, shared, path) => {
      const locks = createPendingRegistrationLockPool(
        {
          runtimeProfile: "public",
          sharedDatabaseUrl: shared,
          contextDatabaseUrls: urls,
          pool: { max: 40, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 7_000 },
          port: 6182,
        },
        {},
      );
      try {
        expect(locks.refusal).toBeNull();
        expect(optionsOf(locks.pool)).toMatchObject({
          max: PENDING_REGISTRATION_LOCK_POOL_MAX,
          connectionTimeoutMillis: 7_000,
        });
        expect(PENDING_REGISTRATION_LOCK_POOL_MAX).toBe(2);
        expect(new URL(optionsOf(locks.pool).connectionString).pathname).toBe(path);
      } finally {
        if (locks.pool) await end(locks.pool);
      }
    },
  );

  it.each(["staging", "production"] as const)(
    "uses only the direct Auth URL in %s, with the runtime user and TLS settings",
    async (environment) => {
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT", environment);
      const locks = createPendingRegistrationLockPool(managed(environment), {
        BOOTSTRAP_DATABASE_URL_AUTH: directAuthUrl,
      });
      try {
        expect(locks.refusal).toBeNull();
        expect(optionsOf(locks.pool)).toMatchObject({ max: 2, connectionString: directAuthUrl });
      } finally {
        if (locks.pool) await end(locks.pool);
      }
    },
  );

  it.each([
    ["missing", managed("staging"), undefined, "BOOTSTRAP_DATABASE_URL_AUTH is not set"],
    ["malformed", managed("staging"), "not a database url", "the lock URL is not a postgres:// URL"],
    ["not postgres", managed("staging"), "https://db.example.test:25060/auth", "the lock URL is not a postgres:// URL"],
    ["a transaction pool", managed("staging"), runtimeAuthUrl, "the lock URL names a transaction pool"],
    [
      "on another port",
      managed("production"),
      directAuthUrl.replace(":25060", ":5432"),
      "BOOTSTRAP_DATABASE_URL_AUTH is not a direct port 25060 URL",
    ],
    [
      "the runtime Auth URL",
      managed("production", directAuthUrl),
      directAuthUrl,
      "BOOTSTRAP_DATABASE_URL_AUTH is the runtime Auth URL",
    ],
    [
      "another user",
      managed("staging"),
      directAuthUrl.replace("auth_runtime", "doadmin"),
      "BOOTSTRAP_DATABASE_URL_AUTH does not use the Auth runtime user",
    ],
    [
      "a malformed user name escape",
      managed("production"),
      directAuthUrl.replace("auth_runtime", "auth%zzruntime"),
      "BOOTSTRAP_DATABASE_URL_AUTH does not use the Auth runtime user",
    ],
    [
      "a different TLS CA path",
      managed("staging"),
      podManagedUrl(directAuthUrl, "/tmp/other-ca.crt"),
      "BOOTSTRAP_DATABASE_URL_AUTH does not use the Auth runtime TLS settings",
    ],
    [
      "without libpq compatibility",
      managed("production"),
      directAuthUrl.replace("uselibpqcompat=true", "uselibpqcompat=false"),
      "BOOTSTRAP_DATABASE_URL_AUTH does not use the Auth runtime TLS settings",
    ],
    [
      "no local URL",
      { runtimeProfile: "public", sharedDatabaseUrl: null, contextDatabaseUrls: {}, port: 6182 },
      undefined,
      "no Auth or shared database URL",
    ],
  ] as const)("refuses a lock URL that is %s without naming a credential", (_, config, lockUrl, reason) => {
    const locks = createPendingRegistrationLockPool(config as PlatformApiBaseConfig, {
      BOOTSTRAP_DATABASE_URL_AUTH: lockUrl,
    });

    expect(locks).toEqual({ pool: null, refusal: `Pending Registration lock pool is absent: ${reason}.` });
    expect(locks.refusal).not.toMatch(/synthetic-secret|auth_runtime|doadmin|db\.example/);
  });

  it("serves the ordinary pools with no lock pool when the lock URL's user name has a malformed escape", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    const runtimePools = createPlatformApiRuntimePools(
      { ...managed("staging"), sharedDatabaseUrl: "postgresql://localhost/shared" },
      { BOOTSTRAP_DATABASE_URL_AUTH: directAuthUrl.replace("auth_runtime", "auth%zzruntime") },
    );
    try {
      expect(runtimePools.pendingRegistrationLocks).toBeNull();
      expect(runtimePools.pendingRegistrationLockRefusal).toBe(
        "Pending Registration lock pool is absent: BOOTSTRAP_DATABASE_URL_AUTH does not use the Auth runtime user.",
      );
      expect(runtimePools.auth).toBeDefined();
      expect(new URL(optionsOf(runtimePools.auth).connectionString).port).toBe("25061");
    } finally {
      await closePlatformApiPools(runtimePools);
    }
  });

  it("hands the serving process's lock pool to Auth only, and closes it with the context pools", async () => {
    const runtimePools = createPlatformApiRuntimePools(
      {
        runtimeProfile: "public",
        sharedDatabaseUrl: "postgresql://localhost/shared",
        contextDatabaseUrls: { auth: "postgresql://localhost/auth" },
        port: 6182,
      },
      {},
    );
    const { pendingRegistrationLocks, pendingRegistrationLockRefusal, ...pools } = runtimePools;
    try {
      expect(pendingRegistrationLockRefusal).toBeNull();
      expect(pendingRegistrationLocks).not.toBe(pools.auth);
      expect(Object.values(pools)).not.toContain(pendingRegistrationLocks);
      const runtime = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          processorGateway: createFakePaymentProcessorGateway(),
          pendingRegistrationLocks: pendingRegistrationLocks!,
        },
      });
      const auth = runtime.services.auth as ReturnType<typeof authModule.createServices>;
      expect(auth.pendingRegistrationLocks).toBe(pendingRegistrationLocks);
      expect(runtime.mountedContexts.find((entry) => entry.contextName === "auth")?.pool).toBe(pools.auth);
    } finally {
      await closePlatformApiPools(runtimePools);
    }
    expect((pendingRegistrationLocks as unknown as { ended: boolean }).ended).toBe(true);
    expect((pools.auth as unknown as { ended: boolean }).ended).toBe(true);

    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("const runtimePools = createPlatformApiRuntimePools(config);");
    expect(main).toContain(
      "const { pendingRegistrationLocks, pendingRegistrationLockRefusal, ...pools } = runtimePools;",
    );
    expect(main).toContain("...(pendingRegistrationLocks ? { pendingRegistrationLocks } : {}),");
    expect(main).toContain("closePlatformApiPools(runtimePools)");
    // The first pool use and the listen call both sit inside the awaited startup boundary.
    const boundary = main.indexOf("\nawait runPlatformApiStartup(runtimePools, async () => {\n");
    expect(boundary).toBeGreaterThan(main.indexOf("const runtimePools = createPlatformApiRuntimePools(config);"));
    expect(main.indexOf("\n  await bootstrapPlatformControlPlane(pools.control);\n")).toBeGreaterThan(boundary);
    expect(main.indexOf("\n  startGracefulHttpServer({\n")).toBeGreaterThan(boundary);
    expect(main).not.toMatch(/^await (?!runPlatformApiStartup\()|^startGracefulHttpServer\(|uncaughtExceptionMonitor/m);
  });

  function fakePools() {
    const pool = () => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn(async () => undefined) });
    const auth = pool();
    const locks = pool();
    return {
      auth,
      locks,
      pools: { auth, identity: auth, pendingRegistrationLocks: locks, pendingRegistrationLockRefusal: null },
    };
  }

  it("ends every distinct pool exactly once however many paths close them", async () => {
    const { auth, locks, pools } = fakePools();

    const first = closePlatformApiPools(pools);
    const second = closePlatformApiPools(pools);
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(auth.end).toHaveBeenCalledTimes(1);
    expect(locks.end).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed startup only after each distinct pool's end settles", async () => {
    const order: string[] = [];
    const deferredPool = (name: string) => {
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      const end = vi.fn(async () => {
        await settled;
        order.push(`${name} ended`);
      });
      return { pool: { query: vi.fn(), connect: vi.fn(), end }, settle };
    };
    const auth = deferredPool("auth");
    const locks = deferredPool("locks");
    const pools = {
      auth: auth.pool,
      identity: auth.pool,
      pendingRegistrationLocks: locks.pool,
      pendingRegistrationLockRefusal: null,
    };
    const failure = new Error("synthetic startup failure");

    const startup = runPlatformApiStartup(pools, async () => {
      throw failure;
    }).catch((error: unknown) => {
      order.push("startup rejected");
      throw error;
    });

    await vi.waitFor(() => expect(locks.pool.end).toHaveBeenCalledTimes(1));
    expect(auth.pool.end).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    auth.settle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["auth ended"]);
    locks.settle();
    await expect(startup).rejects.toBe(failure);
    expect(order).toEqual(["auth ended", "locks ended", "startup rejected"]);
    expect(auth.pool.end).toHaveBeenCalledTimes(1);
    expect(locks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("leaves the pools open for graceful shutdown when startup succeeds", async () => {
    const { auth, locks, pools } = fakePools();

    await expect(runPlatformApiStartup(pools, async () => "listening")).resolves.toBe("listening");

    expect(auth.end).not.toHaveBeenCalled();
    expect(locks.end).not.toHaveBeenCalled();
  });
});

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
