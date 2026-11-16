import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createProjectionGroupLeasePort, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { syncContextProjectionGroups, withSchemaBootstrapLock } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { closePlatformApiPools, createSeedCommandPools } from "../src/database-pools";
import { runAdminQaActorFixtures } from "../src/admin-qa-actor-fixtures";
import type { PlatformApiConfig } from "../src/config";

// Executes each deployable seedApiHostIfEmpty caller with the real control-plane and lease-port
// factories (spied, not replaced), so the port each caller passes is the one built from the real
// PlatformControlPlane over its control pool. Seed API paths are executed in
// infrastructure/platform-runtime/inline-seed-caller-inventory.test.ts; the representative caller in
// representative-commerce-orchestration.test.ts.
vi.mock("@chase-sets/platform-runtime/control-plane", async (original) => {
  const actual = await original<typeof import("@chase-sets/platform-runtime/control-plane")>();
  return {
    ...actual,
    bootstrapPlatformControlPlane: vi.fn(async () => undefined),
    recordWorkerQuiesce: vi.fn(async () => undefined),
    createPostgresPlatformControlPlane: vi.fn(actual.createPostgresPlatformControlPlane),
  };
});
vi.mock("@chase-sets/platform-runtime/api", async (original) => {
  const actual = await original<typeof import("@chase-sets/platform-runtime/api")>();
  return {
    ...actual,
    seedApiHostIfEmpty: vi.fn(async () => undefined),
    createProjectionGroupLeasePort: vi.fn(actual.createProjectionGroupLeasePort),
  };
});
vi.mock("@chase-sets/bounded-context-runtime", async (original) => ({
  ...(await original<object>()),
  syncContextProjectionGroups: vi.fn(async () => undefined),
  withSchemaBootstrapLock: vi.fn(async (_pool: unknown, _options: unknown, run: (lock: unknown) => Promise<void>) =>
    run({ attempts: 1, waited: false }),
  ),
}));
vi.mock("@chase-sets/identity/server", () => ({
  ADMIN_QA_ACTOR_FIXTURES: [],
  provisionAdminQaActorFixtures: vi.fn(async () => []),
  bootstrapPlatformAdminIdentity: vi.fn(async () => ({
    userId: "synthetic-user",
    credentialId: "synthetic-credential",
  })),
}));
vi.mock("@chase-sets/auth/server", () => ({ bootstrapPlatformAdminPassword: vi.fn() }));
vi.mock("@chase-sets/object-storage", () => ({
  createFilesystemObjectStorage: vi.fn(() => ({})),
  createS3ObjectStorage: vi.fn(() => ({})),
}));
vi.mock("../src/generated/api-context-registry", () => ({ apiContextRegistry: [] }));
vi.mock("../src/database-pools", () => ({
  createSeedCommandPools: vi.fn(),
  closePlatformApiPools: vi.fn(async () => undefined),
}));
vi.mock("../src/app", () => ({
  createPlatformApiHost: vi.fn(() => ({
    services: { identity: { db: {}, accounts: {}, users: {}, memberships: {}, consents: {} }, auth: {} },
  })),
}));
vi.mock("../src/bootstrap-storage", () => ({ createPlatformBootstrapStoragePorts: vi.fn(() => ({})) }));
vi.mock("../src/preview-postgres", () => ({ ensurePreviewPostgresDatabases: vi.fn() }));
vi.mock("../src/config", async (original) => ({
  ...(await original<object>()),
  loadBootstrapConfig: vi.fn(() => ({
    runtimeProfile: "public",
    deploymentEnvironment: "staging",
    dataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap"],
    platformAdmin: {
      email: "synthetic-admin@chasesets.test",
      displayName: "Synthetic Admin",
      accountName: "Synthetic Account",
      password: "synthetic-test-password",
    },
  })),
}));

function seedCommandPools() {
  const pool = () => ({ query: vi.fn(async () => ({ rows: [] })), connect: vi.fn() });
  const pools = { control: pool(), schemaBootstrapLockPool: pool() };
  vi.mocked(createSeedCommandPools).mockReturnValue(pools as never);
  return pools;
}

function expectSeedWithRealControlPlanePort(controlPool: unknown, extra: Record<string, unknown>) {
  expect(createPostgresPlatformControlPlane).toHaveBeenCalledTimes(1);
  expect(createPostgresPlatformControlPlane).toHaveBeenCalledWith(controlPool);
  const controlPlane = vi.mocked(createPostgresPlatformControlPlane).mock.results[0]!.value;
  expect(controlPlane).toEqual(expect.objectContaining({ acquireLease: expect.any(Function) }));
  expect(createProjectionGroupLeasePort).toHaveBeenCalledExactlyOnceWith(controlPlane, "platform-api");
  const port = vi.mocked(createProjectionGroupLeasePort).mock.results[0]!.value;
  expect(seedApiHostIfEmpty).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    "platform-api",
    expect.anything(),
    expect.objectContaining({ ...extra, projectionGroupLeasePort: port }),
  );
}

describe("inline seed caller inventory (deployable callers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["infrastructure/bounded-context-runtime/test-support.ts", "@chase-sets/bounded-context-runtime/test-support"],
    ["infrastructure/bounded-context-runtime/projection-operations.db.test.ts", "projection-operations.db.test"],
    [
      "deployables/platform-api/__tests__/bootstrap-production-reconciliation.db.test.ts",
      "bootstrap-production-reconciliation.db.test",
    ],
    [
      "deployables/marketplace-seed-testing/tests/payments-money-feed-coverage.test.ts",
      "payments-money-feed-coverage.test",
    ],
    [
      "deployables/marketplace-seed-testing/tests/representative-commerce-state.test.ts",
      "representative-commerce-state.test",
    ],
    [
      "deployables/marketplace-seed-testing/tests/identity-anchor-representative-reconciliation.test.ts",
      "identity-anchor-representative-reconciliation.test",
    ],
    ["deployables/platform-worker/__tests__/channels-liveness-test-support.ts", "channels-liveness-test-support"],
    ["infrastructure/platform-runtime/concurrency.db.test.ts", "concurrency.db.test"],
  ])("keeps the direct drain in %s test-only, outside production seed composition", (path, importName) => {
    const source = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    expect(source).toMatch(/drainContextRuntime|drainLocalProjectionHandlerSets|syncProjectionGroup|runOnce/);
    for (const caller of ["bootstrap.ts", "representative-commerce-state.ts", "admin-qa-actor-fixtures.ts"]) {
      expect(readFileSync(new URL(`../src/${caller}`, import.meta.url), "utf8")).not.toContain(importName);
    }
  });

  it.each(["identity", "auth"])(
    "aborts and awaits the %s admin drain before reporting its seed timeout",
    async (contextName) => {
      vi.useFakeTimers();
      const { syncBootstrapProjectionGroups } = await import("../src/bootstrap");
      let complete!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let signal: AbortSignal | undefined;
      vi.mocked(syncContextProjectionGroups).mockImplementationOnce(async (_runtime, _name, options) => {
        signal = options?.context?.signal;
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        await cleanup;
        throw new Error("synthetic cancellation");
      });
      const runtime = { mountedContexts: [], projectionGroups: [] };
      const port = createProjectionGroupLeasePort(
        createPostgresPlatformControlPlane(seedCommandPools().control),
        "platform-api",
      );
      let settled = false;
      const run = syncBootstrapProjectionGroups(runtime, contextName, port).finally(() => {
        settled = true;
      });
      const rejected = expect(run).rejects.toMatchObject({
        name: "SeedApiHostSubstepTimeoutError",
        code: "BOOTSTRAP_SEED_SUBSTEP_TIMEOUT",
        message: expect.stringContaining(`projection-sync:${contextName}' exceeded 600000ms`),
      });
      await vi.advanceTimersByTimeAsync(600_001);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      complete();
      await rejected;
      expect(settled).toBe(true);
    },
  );

  it("bootstrap.ts seeds inside its held bootstrap lock with the port built from its control pool", async () => {
    const pools = seedCommandPools();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { bootstrap } = await import("../src/bootstrap");
    await bootstrap();
    expect(closePlatformApiPools).toHaveBeenCalledTimes(1);

    expect(exit).not.toHaveBeenCalled();
    expect(withSchemaBootstrapLock).toHaveBeenCalledWith(
      pools.schemaBootstrapLockPool,
      expect.anything(),
      expect.any(Function),
    );
    expectSeedWithRealControlPlanePort(pools.control, {
      schemaBootstrapLockAcquisition: { attempts: 1, waited: false },
      substepTimeoutMs: 600_000,
    });
    const port = vi.mocked(createProjectionGroupLeasePort).mock.results[0]!.value;
    expect(syncContextProjectionGroups).toHaveBeenCalledTimes(2);
    for (const [index, contextName] of ["identity", "auth"].entries()) {
      expect(syncContextProjectionGroups).toHaveBeenNthCalledWith(index + 1, expect.anything(), contextName, {
        context: { signal: expect.any(AbortSignal) },
        runWithLease: port.runWithLease,
      });
    }
    const order = [
      vi.mocked(seedApiHostIfEmpty).mock.invocationCallOrder[0],
      vi.mocked(syncContextProjectionGroups).mock.invocationCallOrder[0],
      vi.mocked(bootstrapPlatformAdminIdentity).mock.invocationCallOrder[0],
      vi.mocked(syncContextProjectionGroups).mock.invocationCallOrder[1],
      vi.mocked(bootstrapPlatformAdminPassword).mock.invocationCallOrder[0],
      vi.mocked(closePlatformApiPools).mock.invocationCallOrder[0],
    ];
    expect(order.every((value) => value !== undefined)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left! - right!));
  });

  it("admin-qa-actor-fixtures seeds with the seed budget and the port built from its control pool", async () => {
    const pools = seedCommandPools();
    vi.stubEnv("ADMIN_QA_ACTOR_FIXTURES_CONFIRM", "provision admin qa fixtures");
    vi.stubEnv("ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_OUT", "");
    const storage = { kind: "filesystem", rootDir: "unused" };

    await runAdminQaActorFixtures({
      config: {
        deploymentEnvironment: "staging",
        runtimeProfile: "public",
        catalogAssetStorage: storage,
        listingPhotoStorage: storage,
      } as unknown as PlatformApiConfig,
    });

    expect(closePlatformApiPools).toHaveBeenCalledTimes(1);
    expectSeedWithRealControlPlanePort(pools.control, {
      schemaBootstrapLockPool: pools.schemaBootstrapLockPool,
      substepTimeoutMs: 600_000,
    });
  });
});
