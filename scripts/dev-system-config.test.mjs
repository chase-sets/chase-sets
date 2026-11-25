import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserE2eLifecyclePathEnv } from "./browser-e2e-evidence.mjs";
import { buildSandboxEnv, resolveWorktreeSandbox } from "./lib/sandbox.mjs";
import {
  acquireDevSystemHeavySlot,
  applyCurrentPlatformBootstrapSelectors,
  applyDevTargetEnvOverrides,
  browserE2eDirectCiCommands,
  browserE2ePlatformAdminEnv,
  browserE2ePlatformWorkerCiCommand,
  browserE2ePlatformWorkerEnv,
  browserE2eProductionBuilds,
  browserE2eProductionIngressEnv,
  browserE2eProductionTarget,
  browserE2eRateLimitEnv,
  browserE2eReadConsistencyEnv,
  buildPlatformBootstrapEnvironment,
  buildPlatformChildEnvironment,
  buildRepresentativeSnapshotCommandEnvironment,
  createBrowserE2eProductionIngressDefinitions,
  createMarketplaceDevProcessDefinition,
  browserE2eCortenMarketplaceTarget,
  cortenMarketplaceBinaryPath,
  isBrowserE2eTarget,
  resolveBrowserE2eSystemTarget,
} from "./dev-system-config.mjs";

const temporaryDirectories = [];

const marketplaceSandbox = {
  urls: { platformApi: "http://localhost:6412", marketplaceWeb: "http://localhost:6403" },
  ports: { marketplaceWeb: 6403 },
};

function expectMarketplaceCliBinding(source) {
  expect(source).toContain("createMarketplaceDevProcessDefinition,");
  expect(source).toContain("createMarketplaceDevProcessDefinition(sandbox, sandboxEnv),");
  expect(source).toContain('"browser-e2e": ["platform-api", "platform-worker", "admin-web", "marketplace"]');
  expect(source).toContain('marketplace: ["marketplace"]');
  expect(source).toContain("all: processes.map(({ name }) => name)");
  expect(source).toContain("applyDevTargetEnvOverrides(targetName, resolveProcessesForTarget(targetName))");
  expect(source).toContain("env: buildPlatformChildEnvironment(process.env, definition.env)");
}

function expectMarketplaceOrigin(environment) {
  expect(environment.CHASE_SETS_INTERNAL_API_ORIGIN).toBe(marketplaceSandbox.urls.platformApi);
}

describe("marketplace dev sandbox origin", () => {
  it("binds the shared definition into the CLI process table and all three targets", () => {
    const source = readFileSync(new URL("./dev-system.mjs", import.meta.url), "utf8");
    expectMarketplaceCliBinding(source);
    expect(() =>
      expectMarketplaceCliBinding(source.replace("createMarketplaceDevProcessDefinition(sandbox, sandboxEnv),", "")),
    ).toThrow();
  });

  it.each(["browser-e2e", "marketplace", "all"])(
    "resolves the sandbox API origin in the sanitized %s child",
    (target) => {
      const definition = createMarketplaceDevProcessDefinition(marketplaceSandbox, {
        CHASE_SETS_SANDBOX_ID: "synthetic-marketplace-test",
        CHASE_SETS_INTERNAL_API_ORIGIN: "https://synthetic-inherited-api.invalid",
      });
      const [resolved] = applyDevTargetEnvOverrides(target, [definition]);
      const environment = buildPlatformChildEnvironment(
        {
          PATH: "C:\\tools",
          CHASE_SETS_INTERNAL_API_ORIGIN: "https://synthetic-ambient-api.invalid",
          PGHOSTADDR: "203.0.113.42",
          SEED_PACKS_SPACES_SECRET_KEY: "synthetic-secret",
        },
        resolved.env,
      );
      expectMarketplaceOrigin(environment);
      expect(resolved).toMatchObject({
        name: "marketplace",
        workspace: "@chase-sets/app-marketplace-web",
        port: marketplaceSandbox.ports.marketplaceWeb,
        env: {
          CHASE_SETS_SANDBOX_ID: "synthetic-marketplace-test",
          PLATFORM_API_URL: marketplaceSandbox.urls.platformApi,
          VITE_PLATFORM_API_URL: marketplaceSandbox.urls.platformApi,
          PORT: String(marketplaceSandbox.ports.marketplaceWeb),
        },
      });
      expect(environment).toMatchObject(resolved.env);
      expect(environment).not.toHaveProperty("PGHOSTADDR");
      expect(environment).not.toHaveProperty("SEED_PACKS_SPACES_SECRET_KEY");
      const missing = { ...environment };
      delete missing.CHASE_SETS_INTERNAL_API_ORIGIN;
      expect(() => expectMarketplaceOrigin(missing)).toThrow();
      for (const origin of [marketplaceSandbox.urls.marketplaceWeb, "https://synthetic-wrong-origin.invalid"]) {
        expect(() => expectMarketplaceOrigin({ ...environment, CHASE_SETS_INTERNAL_API_ORIGIN: origin })).toThrow();
      }
    },
  );
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createFreshAttemptDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "chase-sets-browser-e2e-attempt-"));
  temporaryDirectories.push(directory);
  return directory;
}

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
    const definition = { name: "platform-worker", workspace: "@chase-sets/app-platform-worker", env: {} };
    for (const platform of ["win32", "linux", "darwin"]) {
      const [selected] = applyDevTargetEnvOverrides("browser-e2e", [definition], {
        ci: true,
        platform,
        environment: {},
      });
      expect(selected).toMatchObject(
        platform === "win32"
          ? { command: undefined, args: undefined, script: "dev:ci" }
          : { command: "pnpm", args: ["--filter", definition.workspace, "run", "dev:ci"] },
      );
    }
  });

  it("keeps the watch-based worker loop for local browser development", () => {
    const worker = { name: "platform-worker", env: { PORT: "6183" } };

    expect(applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: false })[0]).toEqual({
      ...worker,
      env: { ...worker.env, ...browserE2ePlatformWorkerEnv },
    });
  });

  it.each(["browser-e2e", browserE2eProductionTarget])(
    "gives only the %s worker a fresh contained structured-log mirror",
    (targetName) => {
      const attemptDirectory = createFreshAttemptDirectory();
      const lifecyclePath = path.join(attemptDirectory, "lifecycle.json");
      const logFilePath = path.join(attemptDirectory, "platform-worker.jsonl");
      const processes = [
        { name: "platform-api", env: { PORT: "6182" } },
        { name: "platform-worker", env: { PORT: "6183" } },
        { name: "marketplace", env: { PORT: "6173", PLATFORM_API_URL: "http://localhost:6182" }, port: 6173 },
      ];
      const environment = { [browserE2eLifecyclePathEnv]: lifecyclePath };

      expect(existsSync(logFilePath)).toBe(false);
      const selected = applyDevTargetEnvOverrides(targetName, processes, { ci: false, environment });

      expect(selected[0].env).not.toHaveProperty("LOG_FILE_PATH");
      expect(selected[1].env.LOG_FILE_PATH).toBe(logFilePath);
      expect(selected[2].env).not.toHaveProperty("LOG_FILE_PATH");
      expect(buildPlatformChildEnvironment({ PATH: "C:\\tools" }, selected[1].env)).toMatchObject({
        LOG_FILE_PATH: logFilePath,
      });
      expect(existsSync(logFilePath)).toBe(false);

      writeFileSync(logFilePath, "", "utf8");
      expect(statSync(logFilePath).size).toBe(0);
    },
  );

  it("leaves ordinary targets unchanged when browser evidence is absent", () => {
    const attemptDirectory = createFreshAttemptDirectory();
    const worker = { name: "platform-worker", env: { PORT: "6183" } };
    const evidenceEnvironment = {
      [browserE2eLifecyclePathEnv]: path.join(attemptDirectory, "lifecycle.json"),
    };

    expect(applyDevTargetEnvOverrides("marketplace-full", [worker], { environment: evidenceEnvironment })).toEqual([
      worker,
    ]);
    expect(applyDevTargetEnvOverrides("browser-e2e", [worker], { ci: false, environment: {} })[0].env).toEqual({
      PORT: "6183",
      ...browserE2ePlatformWorkerEnv,
    });
  });

  it("refuses a lifecycle evidence path that is not already absolute and resolved", () => {
    const attemptDirectory = createFreshAttemptDirectory();
    const unresolvedLifecyclePath = `${attemptDirectory}${path.sep}nested${path.sep}..${path.sep}lifecycle.json`;

    expect(() =>
      applyDevTargetEnvOverrides("browser-e2e", [{ name: "platform-worker", env: {} }], {
        environment: { [browserE2eLifecyclePathEnv]: unresolvedLifecyclePath },
      }),
    ).toThrow(`${browserE2eLifecyclePathEnv} must be an absolute resolved path.`);
  });

  it("refuses a worker log path outside the lifecycle evidence directory", () => {
    const attemptDirectory = createFreshAttemptDirectory();
    const lifecyclePath = path.join(attemptDirectory, "lifecycle.json");
    const outsideLogPath = path.join(path.dirname(attemptDirectory), "outside-platform-worker.jsonl");

    expect(() =>
      applyDevTargetEnvOverrides("browser-e2e", [{ name: "platform-worker", env: { LOG_FILE_PATH: outsideLogPath } }], {
        environment: { [browserE2eLifecyclePathEnv]: lifecyclePath },
      }),
    ).toThrow("platform-worker.jsonl must resolve inside the lifecycle evidence directory.");
  });

  it("resolves an explicit production system without changing the development default", () => {
    expect(resolveBrowserE2eSystemTarget({})).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "development" })).toBe("browser-e2e");
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "production" })).toBe(
      browserE2eProductionTarget,
    );
    expect(() => resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "preview" })).toThrow(
      /must be "development", "production" or "corten-marketplace"/,
    );
  });

  it("serves the marketplace from the Corten pilot binary behind an ingress on the marketplace port, with the API's internal capability", () => {
    expect(resolveBrowserE2eSystemTarget({ CHASE_SETS_BROWSER_E2E_SYSTEM: "corten-marketplace" })).toBe(
      browserE2eCortenMarketplaceTarget,
    );
    expect(isBrowserE2eTarget(browserE2eCortenMarketplaceTarget)).toBe(true);
    const processes = [
      { name: "platform-api", env: { PORT: "6182" }, port: 6182 },
      {
        name: "marketplace",
        workspace: "@chase-sets/app-marketplace-web",
        env: { PORT: "6173", PLATFORM_API_URL: "http://localhost:6182", CHASE_SETS_INTERNAL_API_ORIGIN: "http://localhost:6182" },
        port: 6173,
      },
    ];
    const [api, marketplace] = applyDevTargetEnvOverrides(browserE2eCortenMarketplaceTarget, processes, {
      ci: true,
      environment: {},
      platform: "linux",
    });
    expect(api.env.PLATFORM_INTERNAL_AUTH_SECRET).toBe(marketplace.env.PLATFORM_INTERNAL_AUTH_SECRET);
    expect(api.env.PLATFORM_INTERNAL_AUTH_SECRET).toMatch(/\S/);
    expect(api.env.CHASE_SETS_TRUST_FORWARDED_HEADERS).toBe("true");
    expect(marketplace).toEqual({
      name: "marketplace",
      command: cortenMarketplaceBinaryPath({}, "linux"),
      args: [],
      env: expect.objectContaining({
        CHASE_SETS_INTERNAL_API_ORIGIN: "http://localhost:6182",
        MARKETPLACE_WEB_ORIGIN: "http://localhost:6173",
        HOST: "127.0.0.1",
        PORT: "6177",
        CHASE_SETS_MARKETPLACE_INDEXING: "off",
      }),
      port: 6177,
      publicPort: 6173,
    });
    expect(marketplace).not.toHaveProperty("workspace");
    expect(
      createBrowserE2eProductionIngressDefinitions([api, marketplace], {
        apiUrl: "http://localhost:6182",
        ingressScriptPath: "/repo/scripts/platform-compose-ingress.mjs",
      }),
    ).toEqual([
      {
        name: "marketplace-ingress",
        command: "node",
        args: [
          "/repo/scripts/platform-compose-ingress.mjs",
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
    expect(cortenMarketplaceBinaryPath({}, "linux")).toMatch(/deployables[\\/]corten-pilot[\\/]target[\\/]debug[\\/]corten-pilot-marketplace$/);
    expect(cortenMarketplaceBinaryPath({ CORTEN_MARKETPLACE_BINARY: "/opt/pilot" }, "linux")).toBe("/opt/pilot");
    // The development target keeps the React marketplace and the API's own default capability.
    const [devApi, devMarketplace] = applyDevTargetEnvOverrides("browser-e2e", processes, { ci: true });
    expect(devApi.env).not.toHaveProperty("PLATFORM_INTERNAL_AUTH_SECRET");
    expect(devMarketplace).toBe(processes[1]);
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

    const productionProcesses = applyDevTargetEnvOverrides(browserE2eProductionTarget, processes, {
      ci: true,
      platform: "linux",
    });
    const windowsProcesses = applyDevTargetEnvOverrides(browserE2eProductionTarget, processes, {
      ci: true,
      platform: "win32",
    });
    const workspaces = [
      "@chase-sets/app-platform-api",
      "@chase-sets/app-platform-worker",
      "@chase-sets/app-admin-web",
      "@chase-sets/app-marketplace-web",
    ];

    productionProcesses.forEach((processDefinition, index) => {
      expect(processDefinition).toMatchObject({
        command: "pnpm",
        args: ["--filter", workspaces[index], "run", "start"],
      });
      expect(processDefinition).not.toHaveProperty("script");
      expect(processDefinition.env).not.toHaveProperty("NODE_ENV");
      expect(processDefinition.args.join(" ")).not.toContain("watch");
    });
    for (const processDefinition of windowsProcesses) {
      expect(processDefinition).toMatchObject({ command: undefined, args: undefined, script: "start" });
      expect(processDefinition.env).not.toHaveProperty("NODE_ENV");
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

  it("recognizes the browser e2e boot targets", () => {
    expect(isBrowserE2eTarget("browser-e2e")).toBe(true);
    expect(isBrowserE2eTarget(browserE2eProductionTarget)).toBe(true);
    expect(isBrowserE2eTarget(browserE2eCortenMarketplaceTarget)).toBe(true);
    expect(isBrowserE2eTarget("marketplace-full")).toBe(false);
  });

  it.each(["browser-e2e", browserE2eProductionTarget])(
    "acquires the script-battery slot for the %s dev target",
    (targetName) => {
      const acquisitions = [];
      const acquireSlot = (kind) => {
        acquisitions.push(kind);
        return true;
      };

      expect(acquireDevSystemHeavySlot("dev", targetName, acquireSlot)).toBe(true);
      expect(acquisitions).toEqual(["script-battery"]);
    },
  );

  it("does not acquire a slot for a non-browser dev target", () => {
    const acquisitions = [];

    expect(
      acquireDevSystemHeavySlot("dev", "marketplace-full", (kind) => {
        acquisitions.push(kind);
        return true;
      }),
    ).toBe(false);
    expect(acquisitions).toEqual([]);
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

  it.each([
    ["@chase-sets/app-platform-api", true, "6520"],
    ["@chase-sets/app-platform-api", false, undefined],
    ["@chase-sets/app-platform-worker", true, undefined],
  ])("hands off only the canonical explicit replay port to %s (replay=%s)", (workspace, replay, expectedPort) => {
    const sandbox = resolveWorktreeSandbox({
      env: { CHASE_SETS_SANDBOX_ID: "synthetic-replay", CHASE_SETS_SANDBOX_BASE_PORT: "6500" },
      contextNames: ["catalog"],
    });
    const environment = buildPlatformBootstrapEnvironment(
      workspace,
      { POSTGRES_DEV_HOST_PORT: "9999", PGHOSTADDR: "203.0.113.42" },
      { ...buildSandboxEnv(sandbox), POSTGRES_DEV_HOST_PORT: "8888", POSTGRES_DB: "hostile" },
      { sandbox, disposableRepresentativeCatalogReplay: replay },
    );
    expect(environment.POSTGRES_DEV_HOST_PORT).toBe(expectedPort);
    expect(environment.DATABASE_URL_CATALOG).toBe(sandbox.contextDatabaseUrls.catalog);
    expect(environment).not.toHaveProperty("PGHOSTADDR");
    expect(environment).not.toHaveProperty("POSTGRES_DB");
  });

  it("threads representative refresh selectors set after process definitions were composed", () => {
    expect(
      applyCurrentPlatformBootstrapSelectors(
        {
          PLATFORM_DATA_PROFILES: "all",
          REPRESENTATIVE_CATALOG_PACK_SOURCE: "C:\\stale-pack-root",
          PORT: "6182",
        },
        {
          PLATFORM_DATA_PROFILES: "critical-bootstrap,catalog-integration-bootstrap,representative-catalog",
          REPRESENTATIVE_CATALOG_PACK_SOURCE: "C:\\lane-01\\accepted-packs",
          REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT: "C:\\lane-01\\artifacts\\replay.json",
        },
      ),
    ).toEqual({
      PLATFORM_DATA_PROFILES: "critical-bootstrap,catalog-integration-bootstrap,representative-catalog",
      REPRESENTATIVE_CATALOG_PACK_SOURCE: "C:\\lane-01\\accepted-packs",
      REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT: "C:\\lane-01\\artifacts\\replay.json",
      PORT: "6182",
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
