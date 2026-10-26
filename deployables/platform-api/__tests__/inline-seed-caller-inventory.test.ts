import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createProjectionGroupLeasePort, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { withSchemaBootstrapLock } from "@chase-sets/bounded-context-runtime";
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
  bootstrapPlatformAdminIdentity: vi.fn(),
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
    services: { identity: { db: {}, accounts: {}, users: {}, memberships: {}, consents: {} } },
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("bootstrap.ts seeds inside its held bootstrap lock with the port built from its control pool", async () => {
    const pools = seedCommandPools();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await import("../src/bootstrap");
    await vi.waitFor(() => expect(closePlatformApiPools).toHaveBeenCalledTimes(1));

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
