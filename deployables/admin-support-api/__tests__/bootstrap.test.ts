import { describe, expect, it, vi } from "vitest";

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

describe("admin-support bootstrap profile", () => {
  it("uses production-safe seed orchestration only", async () => {
    const config = {
      dataProfiles: ["admin-support"],
      deploymentEnvironment: "production",
      platformAdmin: {
        email: "admin@example.com",
        displayName: "Platform Admin",
        accountName: "platform-admin",
        password: "test-password",
      },
    };
    const pools = { control: { kind: "control-pool" } };
    const catalogModule = { contextName: "catalog" };
    const experienceModule = { contextName: "experience" };
    const catalogPool = { kind: "catalog-pool" };
    const experiencePool = { kind: "experience-pool" };
    const runtime = {
      mountedContexts: [
        { contextName: "catalog", module: catalogModule, pool: catalogPool },
        { contextName: "experience", module: experienceModule, pool: experiencePool },
      ],
      services: {
        identity: { kind: "identity-services" },
        auth: { kind: "auth-services" },
      },
    };

    mocks.loadConfig.mockReturnValue(config);
    mocks.createAdminSupportApiPools.mockReturnValue(pools);
    mocks.createAdminSupportApiHost.mockReturnValue(runtime);

    await import("../src/bootstrap");
    await vi.waitFor(() => {
      expect(mocks.closeAdminSupportApiPools).toHaveBeenCalledWith(pools);
    });

    // Control plane plus per-context database bootstrap only - no host-wide seeding.
    expect(mocks.bootstrapPlatformControlPlane).toHaveBeenCalledWith(pools.control);
    expect(mocks.bootstrapContextDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.bootstrapContextDatabase).toHaveBeenNthCalledWith(1, catalogModule, catalogPool);
    expect(mocks.bootstrapContextDatabase).toHaveBeenNthCalledWith(2, experienceModule, experiencePool);

    // Catalog seeding stays scoped to the configured data profiles and environment.
    expect(mocks.bootstrapCatalogDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapCatalogDatabase).toHaveBeenCalledWith(catalogPool, undefined, {
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
});
