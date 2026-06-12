import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapPlatformAdminPassword: vi.fn(async () => undefined),
  bootstrapCatalogDatabase: vi.fn(async () => undefined),
  bootstrapPlatformAdminIdentity: vi.fn(async () => ({
    userId: "usr_admin",
    credentialId: "cred_admin",
  })),
  bootstrapContextDatabase: vi.fn(async () => undefined),
  syncContextProjectionGroups: vi.fn(async () => undefined),
  bootstrapPlatformControlPlane: vi.fn(async () => undefined),
  createAdminSupportApiHost: vi.fn(),
  loadConfig: vi.fn(),
  createAdminSupportApiPools: vi.fn(),
  closeAdminSupportApiPools: vi.fn(async () => undefined),
}));

vi.mock("@chase-sets/auth/server", () => ({
  bootstrapPlatformAdminPassword: mocks.bootstrapPlatformAdminPassword,
}));
vi.mock("@chase-sets/catalog/server", () => ({
  bootstrapCatalogDatabase: mocks.bootstrapCatalogDatabase,
}));
vi.mock("@chase-sets/identity/server", () => ({
  bootstrapPlatformAdminIdentity: mocks.bootstrapPlatformAdminIdentity,
}));
vi.mock("@chase-sets/bounded-context-runtime", () => ({
  bootstrapContextDatabase: mocks.bootstrapContextDatabase,
  syncContextProjectionGroups: mocks.syncContextProjectionGroups,
}));
vi.mock("@chase-sets/platform-runtime/control-plane", () => ({
  bootstrapPlatformControlPlane: mocks.bootstrapPlatformControlPlane,
}));
vi.mock("../src/app", () => ({
  createAdminSupportApiHost: mocks.createAdminSupportApiHost,
}));
vi.mock("../src/config", () => ({
  loadConfig: mocks.loadConfig,
}));
vi.mock("../src/database-pools", () => ({
  createAdminSupportApiPools: mocks.createAdminSupportApiPools,
  closeAdminSupportApiPools: mocks.closeAdminSupportApiPools,
}));

const adminSupportContexts = [
  "auth",
  "catalog",
  "fulfillment",
  "identity",
  "ordering",
  "platform-operations",
  "public-presence",
] as const;

function createRuntime() {
  return {
    mountedContexts: adminSupportContexts.map((contextName) => ({
      contextName,
      module: { contextName },
      pool: { contextName },
    })),
    services: {
      identity: { kind: "identity-services" },
      auth: { kind: "auth-services" },
    },
  };
}

describe("admin-support bootstrap profile", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("bootstraps the current composite contexts without host-wide seeding", async () => {
    const config = {
      dataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap"],
      deploymentEnvironment: "production",
      platformAdmin: {
        email: "admin@example.com",
        displayName: "Platform Admin",
        accountName: "platform-admin",
        password: "test-password",
      },
    };
    const pools = { control: { kind: "control-pool" } };
    const runtime = createRuntime();
    const catalogContext = runtime.mountedContexts.find((entry) => entry.contextName === "catalog");

    mocks.loadConfig.mockReturnValue(config);
    mocks.createAdminSupportApiPools.mockReturnValue(pools);
    mocks.createAdminSupportApiHost.mockReturnValue(runtime);

    await import("../src/bootstrap");
    await vi.waitFor(() => {
      expect(mocks.closeAdminSupportApiPools).toHaveBeenCalledWith(pools);
    });

    // Control plane plus per-context database bootstrap only - no host-wide seeding.
    expect(mocks.bootstrapPlatformControlPlane).toHaveBeenCalledWith(pools.control);
    expect(mocks.bootstrapContextDatabase).toHaveBeenCalledTimes(adminSupportContexts.length);
    for (const [index, context] of runtime.mountedContexts.entries()) {
      expect(mocks.bootstrapContextDatabase).toHaveBeenNthCalledWith(index + 1, context.module, context.pool);
    }
    expect(mocks.bootstrapContextDatabase).not.toHaveBeenCalledWith(
      expect.objectContaining({ contextName: "experience" }),
      expect.anything(),
    );

    // Catalog seeding stays scoped to the configured data profiles and environment.
    expect(mocks.bootstrapCatalogDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapCatalogDatabase).toHaveBeenCalledWith(catalogContext?.pool, undefined, {
      enabledDataProfiles: config.dataProfiles,
      environmentName: config.deploymentEnvironment,
    });

    // Platform admin reconciliation runs through identity and auth bootstrap helpers,
    // with the auth projections synced between the two steps.
    expect(mocks.bootstrapPlatformAdminIdentity).toHaveBeenCalledWith(runtime.services.identity, {
      email: config.platformAdmin.email,
      displayName: config.platformAdmin.displayName,
      accountName: config.platformAdmin.accountName,
    });
    expect(mocks.syncContextProjectionGroups).toHaveBeenCalledWith(runtime, "auth");
    expect(mocks.bootstrapPlatformAdminPassword).toHaveBeenCalledWith(runtime.services.auth, {
      userId: "usr_admin",
      credentialId: "cred_admin",
      password: config.platformAdmin.password,
    });
    expect(mocks.bootstrapPlatformAdminIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncContextProjectionGroups.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.syncContextProjectionGroups.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.bootstrapPlatformAdminPassword.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("skips platform admin reconciliation when the deployment job omits admin credentials", async () => {
    const config = {
      dataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap"],
      deploymentEnvironment: "production",
      platformAdmin: null,
    };
    const pools = { control: { kind: "control-pool" } };
    const runtime = createRuntime();

    mocks.loadConfig.mockReturnValue(config);
    mocks.createAdminSupportApiPools.mockReturnValue(pools);
    mocks.createAdminSupportApiHost.mockReturnValue(runtime);

    await import("../src/bootstrap");
    await vi.waitFor(() => {
      expect(mocks.closeAdminSupportApiPools).toHaveBeenCalledWith(pools);
    });

    expect(mocks.bootstrapPlatformAdminIdentity).not.toHaveBeenCalled();
    expect(mocks.syncContextProjectionGroups).not.toHaveBeenCalled();
    expect(mocks.bootstrapPlatformAdminPassword).not.toHaveBeenCalled();
    expect(mocks.bootstrapContextDatabase).toHaveBeenCalledTimes(adminSupportContexts.length);
    expect(mocks.bootstrapCatalogDatabase).toHaveBeenCalledTimes(1);
  });
});
