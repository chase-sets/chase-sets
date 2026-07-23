import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  browserE2eDirectCiCommands,
  browserE2ePlatformAdminEnv,
  browserE2ePlatformWorkerCiCommand,
  browserE2ePlatformWorkerEnv,
  browserE2eProductionBuilds,
  browserE2eProductionCommands,
  browserE2eProductionIngressEnv,
  browserE2eProductionTarget,
  browserE2eRateLimitEnv,
  browserE2eReadConsistencyEnv,
  buildPlatformChildEnvironment,
  buildRepresentativeSnapshotCommandEnvironment,
  createBrowserE2eProductionIngressDefinitions,
  isBrowserE2eTarget,
  resolveBrowserE2eSystemTarget,
} from "./dev-system-config.mjs";

describe("dev system target env overrides", () => {
  it("configures only the browser e2e platform api with test-safe runtime overrides", () => {
    const processes = [
      { name: "platform-api", env: { PORT: "6182" } },
      {
        name: "platform-worker",
        env: {
          PORT: "6183",
          DATABASE_URL_IDENTITY: "postgres://identity",
        },
      },
      { name: "marketplace", env: { PORT: "6173" } },
    ];

    expect(applyDevTargetEnvOverrides("marketplace-full", processes, { ci: true })).toBe(processes);

    const browserE2eProcesses = applyDevTargetEnvOverrides("browser-e2e", processes, { ci: true });
    expect(browserE2eProcesses).not.toBe(processes);
    expect(browserE2eProcesses[0]).toMatchObject({
      name: "platform-api",
      env: {
        PORT: "6182",
        ...browserE2eRateLimitEnv,
        ...browserE2ePlatformAdminEnv,
        ...browserE2eReadConsistencyEnv,
      },
    });
    expect(browserE2eProcesses[1]).toEqual({
      name: "platform-worker",
      env: {
        PORT: "6183",
        DATABASE_URL_IDENTITY: "postgres://identity",
        ...browserE2ePlatformWorkerEnv,
      },
      ...browserE2ePlatformWorkerCiCommand,
    });
    expect(browserE2eProcesses[2]).toBe(processes[2]);
    expect(processes[0].env).toEqual({ PORT: "6182" });
  });

  it("starts the CI worker through its declared non-watch script", () => {
    expect(browserE2ePlatformWorkerCiCommand).toMatchObject({
      args: ["--filter", "@chase-sets/app-platform-worker", "run", "dev:ci"],
    });
  });

  it("keeps the watch-based worker loop for local browser development", () => {
    const worker = { name: "platform-worker", env: { PORT: "6183" } };

    expect(applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: false })[0]).toEqual({
      ...worker,
      env: { ...worker.env, ...browserE2ePlatformWorkerEnv },
    });
  });

  it("resolves an explicit production system without changing the development default", () => {
    expect(resolveBrowserE2eSystemTarget({})).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "development" })).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "production" })).toBe(
      browserE2eProductionTarget,
    );
    expect(() => resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "preview" })).toThrow(
      /must be "development" or "production"/,
    );
  });

  it("starts every production browser e2e component without a watch wrapper", () => {
    const processes = [
      { name: "platform-api", env: { PORT: "6182" }, port: 6182 },
      { name: "platform-worker", env: { PORT: "6183" }, port: 6183 },
      {
        name: "admin-web",
        env: { PORT: "6174", PLATFORM_API_URL: "http://localhost:6182" },
        port: 6174,
      },
      {
        name: "marketplace",
        env: { PORT: "6173", PLATFORM_API_URL: "http://localhost:6182" },
        port: 6173,
      },
    ];

    const productionProcesses = applyDevTargetEnvOverrides(browserE2eProductionTarget, processes, { ci: true });

    for (const processDefinition of productionProcesses) {
      expect(processDefinition).toMatchObject({
        ...browserE2eProductionCommands[processDefinition.name],
      });
      expect(processDefinition.env).not.toHaveProperty("NODE_ENV");
      expect(processDefinition.args.join(" ")).not.toContain("watch");
    }
    expect(productionProcesses[0].env).toMatchObject(browserE2eProductionIngressEnv);
    expect(productionProcesses[0]).not.toHaveProperty("publicPort");
    expect(productionProcesses[1]).not.toHaveProperty("publicPort");
    expect(productionProcesses[2]).toMatchObject({
      port: 6178,
      publicPort: 6174,
      env: {
        ...browserE2eProductionIngressEnv,
        CHASE_SETS_INTERNAL_API_ORIGIN: "http://localhost:6182",
        PORT: "6178",
      },
    });
    expect(productionProcesses[3]).toMatchObject({
      port: 6177,
      publicPort: 6173,
      env: {
        ...browserE2eProductionIngressEnv,
        CHASE_SETS_INTERNAL_API_ORIGIN: "http://localhost:6182",
        PORT: "6177",
      },
    });
    expect(browserE2eProductionBuilds).toEqual([
      { name: "admin-web", workspace: "@chase-sets/app-admin-web" },
      { name: "marketplace", workspace: "@chase-sets/app-marketplace-web" },
    ]);
  });

  it("recognizes both browser e2e boot targets", () => {
    expect(isBrowserE2eTarget("browser-e2e")).toBe(true);
    expect(isBrowserE2eTarget(browserE2eProductionTarget)).toBe(true);
    expect(isBrowserE2eTarget("marketplace-full")).toBe(false);
  });

  it("routes production web origins through the deployment-faithful ingress", () => {
    const definitions = [
      { name: "platform-api", port: 6182 },
      { name: "admin-web", port: 6178, publicPort: 6174 },
      { name: "marketplace", port: 6177, publicPort: 6173 },
    ];

    expect(
      createBrowserE2eProductionIngressDefinitions(definitions, {
        apiUrl: "http://localhost:6182",
        ingressScriptPath: "C:/repo/scripts/platform-compose-ingress.mjs",
      }),
    ).toEqual([
      {
        name: "admin-web-ingress",
        command: "node",
        args: [
          "C:/repo/scripts/platform-compose-ingress.mjs",
          "--port",
          "6174",
          "--label",
          "admin-web",
          "--web-target",
          "http://127.0.0.1:6178",
          "--api-target",
          "http://localhost:6182",
        ],
        env: {},
        port: 6174,
      },
      {
        name: "marketplace-ingress",
        command: "node",
        args: [
          "C:/repo/scripts/platform-compose-ingress.mjs",
          "--port",
          "6173",
          "--label",
          "marketplace",
          "--web-target",
          "http://127.0.0.1:6177",
          "--api-target",
          "http://localhost:6182",
        ],
        env: {},
        port: 6173,
      },
    ]);
  });

  it("fails before boot when a production web lacks its deployed internal API origin", () => {
    expect(() =>
      applyDevTargetEnvOverrides(browserE2eProductionTarget, [
        { name: "marketplace", env: { PORT: "6173" }, port: 6173 },
      ]),
    ).toThrow(/marketplace requires PLATFORM_API_URL/);
  });

  it("scrubs ambient database selectors and every Space credential from platform children", () => {
    const childEnvironment = buildPlatformChildEnvironment(
      {
        PATH: "C:\\tools",
        PGHOSTADDR: "203.0.113.42",
        DB_HOST: "remote.example",
        POSTGRES_DB: "hostile",
        DATABASE_URL: "postgresql://remote.example/hostile",
        POSTGRES_DEV_DATABASE_URL: "postgresql://remote.example/hostile",
        RELEASE_EVIDENCE_SPACES_ACCESS_ID: "release-access",
        RELEASE_EVIDENCE_SPACES_SECRET_KEY: "release-secret",
        SEED_PACKS_SPACES_ACCESS_ID: "snapshot-access",
        SEED_PACKS_SPACES_SECRET_KEY: "snapshot-secret",
        STRIPE_SECRET_KEY: "stripe-local",
      },
      {
        DATABASE_URL: "",
        POSTGRES_DEV_DATABASE_URL: "postgresql://localhost:6520/canonical",
      },
    );

    expect(childEnvironment).toEqual({
      PATH: "C:\\tools",
      STRIPE_SECRET_KEY: "stripe-local",
      DATABASE_URL: "",
      POSTGRES_DEV_DATABASE_URL: "postgresql://localhost:6520/canonical",
    });
    expect(
      buildPlatformChildEnvironment(
        { PATH: "C:\\tools", STRIPE_SECRET_KEY: "stripe-local" },
        { POSTGRES_DEV_DATABASE_URL: "postgresql://localhost:6520/canonical" },
        { minimalBase: true },
      ),
    ).toEqual({
      PATH: "C:\\tools",
      POSTGRES_DEV_DATABASE_URL: "postgresql://localhost:6520/canonical",
    });
  });

  it("refuses an explicit non-local database selector instead of passing it to a platform child", () => {
    expect(() =>
      buildPlatformChildEnvironment(
        { PATH: "C:\\tools" },
        { DATABASE_URL_CATALOG: "postgresql://remote.example/catalog" },
      ),
    ).toThrow(/DATABASE_URL_CATALOG must be a local sandbox PostgreSQL URL/);
  });

  it("gives the snapshot command only its scoped object-storage credentials", () => {
    const childEnvironment = buildRepresentativeSnapshotCommandEnvironment(
      {
        PATH: "C:\\tools",
        PGHOSTADDR: "203.0.113.43",
        RELEASE_EVIDENCE_SPACES_ACCESS_ID: "release-access",
        RELEASE_EVIDENCE_SPACES_SECRET_KEY: "release-secret",
        SEED_PACKS_SPACES_ACCESS_ID: "snapshot-access",
        SEED_PACKS_SPACES_SECRET_KEY: "snapshot-secret",
        REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS: "packs/one/manifest.json",
      },
      {
        CHASE_SETS_SANDBOX_ID: "lane-01",
        POSTGRES_DEV_DATABASE_URL: "postgresql://localhost:6520/canonical",
      },
    );

    expect(childEnvironment).toEqual({
      PATH: "C:\\tools",
      CHASE_SETS_SANDBOX_ID: "lane-01",
      REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS: "packs/one/manifest.json",
      SEED_PACKS_SPACES_ACCESS_ID: "snapshot-access",
      SEED_PACKS_SPACES_SECRET_KEY: "snapshot-secret",
    });
    expect(childEnvironment).not.toHaveProperty("PGHOSTADDR");
    expect(childEnvironment).not.toHaveProperty("RELEASE_EVIDENCE_SPACES_ACCESS_ID");
    expect(childEnvironment).not.toHaveProperty("RELEASE_EVIDENCE_SPACES_SECRET_KEY");
  });
});
