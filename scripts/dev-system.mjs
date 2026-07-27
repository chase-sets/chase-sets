import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createBrowserE2eLifecycleRecorder, resolveBrowserE2eEvidencePaths } from "./browser-e2e-evidence.mjs";
import { primeBrowserE2eProjectionWakeRelayCursors } from "./browser-e2e-readiness.mjs";
import {
  applyCurrentPlatformBootstrapSelectors,
  applyDevTargetEnvOverrides,
  browserE2eProductionBuilds,
  browserE2eProductionTarget,
  buildPlatformChildEnvironment,
  buildRepresentativeSnapshotCommandEnvironment,
  createBrowserE2eProductionIngressDefinitions,
  isBrowserE2eTarget,
} from "./dev-system-config.mjs";
import { readEnvFile } from "./lib/env.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { stopComposePostgresCleanly } from "./lib/postgres-compose-lifecycle.mjs";
import { buildPackageManagerInvocation, runCommand, spawnCommand, terminateProcessTree } from "./lib/process.mjs";
import {
  applySandboxEnv,
  buildDockerComposeArgs,
  ensureWorktreeSandboxEnvironment,
  getContextDatabaseEnvName,
  listSandboxDatabases,
} from "./lib/sandbox.mjs";

const mode = process.argv[2] ?? "dev";
const modeArguments = process.argv.slice(3);
const representativeRefresh = modeArguments.includes("--representative");
const replayRepresentativeRefresh = modeArguments.includes("--replay");
const target = modeArguments.find((argument) => !argument.startsWith("--")) ?? "all";
if (mode === "dev" && target === "browser-e2e") acquireHeavySlot("script-battery");
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { sandbox, env: sandboxEnv } = ensureWorktreeSandboxEnvironment({ rootDir });
applySandboxEnv(sandboxEnv);
const localEnvScript = fileURLToPath(new URL("./local-env.mjs", import.meta.url));
const platformComposeIngressScript = fileURLToPath(new URL("./platform-compose-ingress.mjs", import.meta.url));
const stripeCliScript = fileURLToPath(new URL("./stripe-cli.mjs", import.meta.url));
const dockerComposeInvocation = resolveDockerComposeInvocation(buildDockerComposeArgs(sandbox));
const localAdminDatabaseUrl =
  process.env.POSTGRES_DEV_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";
const devDatabaseUrl = process.env.POSTGRES_DEV_DATABASE_URL ?? sandbox.controlDatabaseUrl;
const requiredExtensions = ["vector"];
const extensionContextNames = new Set(["discovery"]);
const platformApiEnvExamplePath = path.join(rootDir, "deployables", "platform-api", ".env.example");
const platformApiEnvLocalPath = path.join(rootDir, "deployables", "platform-api", ".env.local");
const stripeReadyTimeoutMs = 20_000;
const postgresReadyTimeoutMs = 90_000;
const postgresReadyPollMs = 1_000;
const isolatedBrowserE2eProbe = process.env.CHASE_SETS_BROWSER_E2E_PROBE === "true";

function createAdminCandidateUrls(databaseName = "postgres") {
  return [localAdminDatabaseUrl].map((baseAdminUrl) => {
    const url = new URL(baseAdminUrl);
    url.pathname = `/${databaseName}`;
    return url.toString();
  });
}

function escapeIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseOwnedDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const roleName = url.username;
  const password = url.password;
  const databaseName = url.pathname.replace(/^\//, "");

  if (!roleName || !password || !databaseName) {
    throw new Error(`Owned database URL "${databaseUrl}" must include role, password, and database name.`);
  }

  return { roleName, password, databaseName, databaseUrl };
}

async function ensureOwnedDatabase(adminPool, spec) {
  const roleExists = await adminPool.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [
    spec.roleName,
  ]);

  if (roleExists.rows[0]?.exists) {
    await adminPool.query(
      `ALTER ROLE ${escapeIdentifier(spec.roleName)} WITH LOGIN PASSWORD ${escapeLiteral(spec.password)}`,
    );
  } else {
    await adminPool.query(
      `CREATE ROLE ${escapeIdentifier(spec.roleName)} WITH LOGIN PASSWORD ${escapeLiteral(spec.password)}`,
    );
  }

  const databaseExists = await adminPool.query(
    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [spec.databaseName],
  );

  if (!databaseExists.rows[0]?.exists) {
    await adminPool.query(
      `CREATE DATABASE ${escapeIdentifier(spec.databaseName)} OWNER ${escapeIdentifier(spec.roleName)}`,
    );
  } else {
    await adminPool.query(
      `ALTER DATABASE ${escapeIdentifier(spec.databaseName)} OWNER TO ${escapeIdentifier(spec.roleName)}`,
    );
  }

  await adminPool.query(
    `GRANT ALL PRIVILEGES ON DATABASE ${escapeIdentifier(spec.databaseName)} TO ${escapeIdentifier(spec.roleName)}`,
  );
}

async function withAdminPool(action, databaseName = "postgres") {
  const adminUrls = createAdminCandidateUrls(databaseName);
  let lastError = null;
  const deadline = Date.now() + postgresReadyTimeoutMs;

  while (Date.now() < deadline) {
    for (const databaseUrl of adminUrls) {
      const pool = new pg.Pool({ connectionString: databaseUrl });

      try {
        await pool.query("SELECT 1");
        return await action(pool);
      } catch (error) {
        lastError = error;
      } finally {
        await pool.end().catch(() => undefined);
      }
    }

    await sleep(postgresReadyPollMs);
  }

  throw lastError ?? new Error("Unable to connect to the dev Postgres admin database.");
}

async function preparePlatformDatabase() {
  await withAdminPool(async (adminPool) => {
    for (const { databaseUrl } of listSandboxDatabases(sandbox)) {
      await ensureOwnedDatabase(adminPool, parseOwnedDatabaseUrl(databaseUrl));
    }
  });

  for (const [contextName, databaseUrl] of Object.entries(sandbox.contextDatabaseUrls)) {
    if (!extensionContextNames.has(contextName)) {
      continue;
    }

    const { databaseName } = parseOwnedDatabaseUrl(databaseUrl);
    await withAdminPool(async (adminPool) => {
      for (const extensionName of requiredExtensions) {
        await adminPool.query(`CREATE EXTENSION IF NOT EXISTS ${escapeIdentifier(extensionName)}`);
      }
    }, databaseName);
  }
}

const bootstrapWorkspaces = ["@chase-sets/app-platform-api", "@chase-sets/app-platform-worker"];

function buildContextDatabaseEnv() {
  return Object.fromEntries(
    Object.entries(sandbox.contextDatabaseUrls).map(([contextName, databaseUrl]) => [
      getContextDatabaseEnvName(contextName),
      databaseUrl,
    ]),
  );
}

const contextDatabaseEnv = buildContextDatabaseEnv();
const commonPlatformEnv = {
  ...sandboxEnv,
  DATABASE_URL: "",
  POSTGRES_DEV_DATABASE_URL: devDatabaseUrl,
  PLATFORM_CONTROL_DATABASE_URL: sandbox.controlDatabaseUrl,
  NOTIFICATION_EMAIL_PROVIDER: process.env.NOTIFICATION_EMAIL_PROVIDER ?? "noop",
  ...(process.env.PLATFORM_DATA_PROFILES ? { PLATFORM_DATA_PROFILES: process.env.PLATFORM_DATA_PROFILES } : {}),
  ...(process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE
    ? { REPRESENTATIVE_CATALOG_PACK_SOURCE: process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE }
    : {}),
  ...contextDatabaseEnv,
};

const processes = [
  {
    name: "platform-api",
    workspace: "@chase-sets/app-platform-api",
    env: {
      ...commonPlatformEnv,
      PORT: String(sandbox.ports.platformApi),
    },
    port: sandbox.ports.platformApi,
  },
  {
    name: "platform-worker",
    workspace: "@chase-sets/app-platform-worker",
    env: {
      ...commonPlatformEnv,
      PORT: String(sandbox.ports.platformWorker),
    },
    port: sandbox.ports.platformWorker,
  },
  {
    name: "admin-web",
    workspace: "@chase-sets/app-admin-web",
    env: {
      ...sandboxEnv,
      PLATFORM_API_URL: sandbox.urls.platformApi,
      VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
      PORT: String(sandbox.ports.adminWeb),
    },
    port: sandbox.ports.adminWeb,
  },
  {
    name: "marketplace",
    workspace: "@chase-sets/app-marketplace-web",
    env: {
      ...sandboxEnv,
      PLATFORM_API_URL: sandbox.urls.platformApi,
      VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
      PORT: String(sandbox.ports.marketplaceWeb),
    },
    port: sandbox.ports.marketplaceWeb,
  },
  {
    name: "public-web",
    workspace: "@chase-sets/app-public-web",
    env: {
      ...sandboxEnv,
      PLATFORM_API_URL: sandbox.urls.platformApi,
      VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
      PORT: String(sandbox.ports.publicWeb),
    },
    port: sandbox.ports.publicWeb,
  },
];

const devTargets = {
  all: processes.map(({ name }) => name),
  "platform-api": ["platform-api"],
  "platform-worker": ["platform-worker"],
  "admin-web": ["platform-api", "platform-worker", "admin-web"],
  "browser-e2e": ["platform-api", "platform-worker", "admin-web", "marketplace"],
  [browserE2eProductionTarget]: ["platform-api", "platform-worker", "admin-web", "marketplace"],
  marketplace: ["marketplace"],
  "marketplace-full": ["platform-api", "platform-worker", "marketplace"],
  "public-web": ["platform-api", "platform-worker", "public-web"],
};

function resolveProcessesForTarget(targetName) {
  const processNames = devTargets[targetName];

  if (!processNames) {
    throw new Error(`Unknown dev target "${targetName}". Use one of: ${Object.keys(devTargets).join(", ")}.`);
  }

  return processes.filter((definition) => processNames.includes(definition.name));
}

function prefixedConsole(prefix, message) {
  const lines = message.replace(/\r/g, "").split("\n");

  for (const line of lines) {
    if (!line) {
      continue;
    }

    console.log(`[${prefix}] ${line}`);
  }
}

function resolveMarketplaceStripeConfig() {
  if (isolatedBrowserE2eProbe) {
    return { secretKey: "", publishableKey: "" };
  }

  const envExample = readEnvFile(platformApiEnvExamplePath);
  const envLocal = readEnvFile(platformApiEnvLocalPath);

  return {
    secretKey: process.env.STRIPE_SECRET_KEY ?? envLocal.STRIPE_SECRET_KEY ?? envExample.STRIPE_SECRET_KEY ?? "",
    publishableKey:
      process.env.STRIPE_PUBLISHABLE_KEY ?? envLocal.STRIPE_PUBLISHABLE_KEY ?? envExample.STRIPE_PUBLISHABLE_KEY ?? "",
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStripeReady(readyFilePath, child) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < stripeReadyTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error("Stripe listener exited before it reported a webhook secret.");
    }

    if (existsSync(readyFilePath)) {
      const secret = readFileSync(readyFilePath, "utf8").trim();
      if (secret.startsWith("whsec_")) {
        return secret;
      }
    }

    await sleep(200);
  }

  throw new Error(`Stripe listener did not report a webhook secret within ${stripeReadyTimeoutMs / 1000} seconds.`);
}

function isPortInUseError(error) {
  return (
    error && typeof error === "object" && "code" in error && (error.code === "EADDRINUSE" || error.code === "EACCES")
  );
}

function isConnectionRefusedError(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ETIMEDOUT")
  );
}

function canConnectToPort(port, host) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", (error) => {
      socket.destroy();

      if (isConnectionRefusedError(error)) {
        resolve(false);
        return;
      }

      reject(error);
    });

    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function hasExistingListener(port) {
  const hosts = ["127.0.0.1", "::1", "localhost"];

  for (const host of hosts) {
    if (await canConnectToPort(port, host)) {
      return true;
    }
  }

  return false;
}

function isPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (isPortInUseError(error)) {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.once("listening", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(true);
      });
    });

    server.listen(port);
  });
}

function listListeningProcessIds(port) {
  if (!Number.isInteger(port) || port <= 0) {
    return [];
  }

  if (process.platform === "win32") {
    const command = [
      "$connections = Get-NetTCPConnection -State Listen -LocalPort",
      `${port}`,
      "-ErrorAction SilentlyContinue;",
      "if ($connections) {",
      "  $connections | Select-Object -ExpandProperty OwningProcess -Unique",
      "}",
    ].join(" ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`Unable to inspect listeners on port ${port}: ${result.stderr?.trim() || "unknown error"}`);
    }

    return String(result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      return [];
    }

    throw result.error;
  }

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to inspect listeners on port ${port}: ${result.stderr?.trim() || "unknown error"}`);
  }

  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function assertSandboxPortAvailable(port, label) {
  const hasListener = (await hasExistingListener(port)) || !(await isPortAvailable(port));
  if (!hasListener) {
    return false;
  }

  const pids = listListeningProcessIds(port);
  const ownerHint = pids.length > 0 ? ` PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}` : " an unknown listener";
  throw new Error(
    `${label} cannot start because sandbox port ${port} is already in use by${ownerHint}. ` +
      "Run pnpm run sandbox:doctor to inspect this worktree sandbox, or override CHASE_SETS_SANDBOX_BASE_PORT.",
  );
}

async function ensureDevDatabase() {
  prefixedConsole("dev", `Starting sandbox Postgres for ${sandbox.id}...`);
  await runCommand(dockerComposeInvocation.command, [...dockerComposeInvocation.args, "up", "-d"], {
    env: sandboxEnv,
    prefix: "docker",
  });
  prefixedConsole("dev", `Provisioning sandbox databases for ${sandbox.id}...`);
  await preparePlatformDatabase();
}

async function runBootstrap(targetName = "all") {
  if (isolatedBrowserE2eProbe) {
    prefixedConsole("env", "Skipping local secret-file sync for the isolated browser-e2e probe.");
  } else {
    await runCommand("node", [localEnvScript, "sync"], {
      prefix: "env",
    });
  }
  ensureWorktreeSandboxEnvironment({ rootDir });
  await ensureDevDatabase();

  const bootstrapProcesses = applyDevTargetEnvOverrides(targetName, processes);
  for (const workspace of bootstrapWorkspaces) {
    prefixedConsole("bootstrap", `Running ${workspace} bootstrap...`);
    const processDefinition = bootstrapProcesses.find((definition) => definition.workspace === workspace);
    const invocation = buildPackageManagerInvocation(["--filter", workspace, "run", "bootstrap"]);
    await runCommand(invocation.command, invocation.args, {
      env: buildPlatformChildEnvironment(
        process.env,
        applyCurrentPlatformBootstrapSelectors(processDefinition?.env ?? {}, process.env),
        { minimalBase: true },
      ),
      inheritEnv: false,
      prefix: workspace.replace("@chase-sets/", ""),
    });
  }
}

function printDevUrls(targetName, selectedProcesses, includePortal = false) {
  console.log("");
  console.log(
    targetName === "all" ? `Local dev system (${sandbox.id})` : `Local dev stack: ${targetName} (${sandbox.id})`,
  );

  if (includePortal) {
    console.log(`  Dev Portal:      ${sandbox.urls.portal}`);
  }

  for (const definition of selectedProcesses) {
    console.log(`  ${definition.name.padEnd(16)} http://localhost:${definition.publicPort ?? definition.port}`);
  }

  console.log(`  Sandbox env:     ${path.relative(rootDir, sandbox.envFilePath)}`);
  console.log(`  Compose project: ${sandbox.composeProjectName}`);
  console.log("");
}

async function runDev(targetName = "all") {
  const lifecycleRecorder = isBrowserE2eTarget(targetName)
    ? createBrowserE2eLifecycleRecorder({
        filePath: resolveBrowserE2eEvidencePaths(sandbox).lifecyclePath,
        sandboxId: sandbox.id,
        target: targetName,
      })
    : null;
  await runBootstrap(targetName);
  if (isBrowserE2eTarget(targetName) && Boolean(process.env.CI)) {
    const primedCount = await primeBrowserE2eProjectionWakeRelayCursors({ sandbox });
    prefixedConsole("bootstrap", `Primed projection wake relay cursors at ${primedCount} seeded context event heads.`);
  }
  const selectedProcesses = applyDevTargetEnvOverrides(targetName, resolveProcessesForTarget(targetName));

  if (targetName === browserE2eProductionTarget) {
    for (const build of browserE2eProductionBuilds) {
      const processDefinition = selectedProcesses.find((definition) => definition.name === build.name);
      prefixedConsole("build", `Building production ${build.name} artifact...`);
      const invocation = buildPackageManagerInvocation(["--filter", build.workspace, "run", "build"]);
      await runCommand(invocation.command, invocation.args, {
        env: buildPlatformChildEnvironment(process.env, processDefinition?.env ?? {}),
        inheritEnv: false,
        prefix: build.name,
      });
    }

    selectedProcesses.push(
      ...createBrowserE2eProductionIngressDefinitions(selectedProcesses, {
        apiUrl: sandbox.urls.platformApi,
        ingressScriptPath: platformComposeIngressScript,
      }),
    );
  }

  printDevUrls(targetName, selectedProcesses, targetName === "all");

  const children = [];
  let shuttingDown = false;

  const shutdown = (signal, exitCode = 0) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    prefixedConsole("dev", `Stopping child processes${signal ? ` after ${signal}` : ""}...`);

    for (const child of children) {
      terminateProcessTree(child, "SIGTERM");
    }

    setTimeout(() => {
      for (const child of children) {
        terminateProcessTree(child, "SIGKILL");
      }
    }, 3_000).unref();

    setTimeout(() => process.exit(exitCode), 100).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT", 0));
  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  process.once("message", (message) => {
    if (message && typeof message === "object" && message.type === "browser-e2e-probe-shutdown") {
      shutdown("probe", 0);
    }
  });

  const platformApiDefinition = selectedProcesses.find((definition) => definition.name === "platform-api");

  if (platformApiDefinition) {
    await assertSandboxPortAvailable(platformApiDefinition.port, platformApiDefinition.name);

    const stripeConfig = resolveMarketplaceStripeConfig();

    if (stripeConfig.secretKey && stripeConfig.publishableKey) {
      const readyFilePath = path.join(os.tmpdir(), `chase-sets-stripe-ready-${process.pid}-${Date.now()}.txt`);
      const stripeListener = spawnCommand("node", [stripeCliScript, "listen"], {
        env: {
          STRIPE_READY_FILE: readyFilePath,
        },
        prefix: "stripe",
      });

      stripeListener.on("error", (error) => {
        if (!shuttingDown) {
          console.error(`[stripe] Failed to start: ${error.message}`);
          shutdown("stripe", 1);
        }
      });

      stripeListener.on("exit", (code) => {
        if (!shuttingDown && code !== 0) {
          console.error(`[stripe] exited unexpectedly with code ${code ?? "unknown"}.`);
          shutdown("stripe", code ?? 1);
        }
      });

      children.push(stripeListener);

      try {
        await waitForStripeReady(readyFilePath, stripeListener);
        const updatedSandboxEnv = readEnvFile(sandbox.envFilePath);
        for (const definition of processes) {
          definition.env = {
            ...definition.env,
            STRIPE_WEBHOOK_SECRET: updatedSandboxEnv.STRIPE_WEBHOOK_SECRET ?? definition.env.STRIPE_WEBHOOK_SECRET,
          };
        }
        prefixedConsole("dev", "Stripe listener is ready. platform-api will start with the current webhook secret.");
      } catch (error) {
        if (!stripeListener.killed) {
          stripeListener.kill("SIGTERM");
        }
        throw error;
      }
    } else {
      prefixedConsole(
        "dev",
        "Stripe keys are incomplete in deployables/platform-api/.env.local, so platform-api will use the fake payment processor.",
      );
    }
  }

  if (targetName === "all") {
    await assertSandboxPortAvailable(sandbox.ports.portal, "portal");
    const portalScript = fileURLToPath(new URL("./dev-portal.mjs", import.meta.url));
    const portal = spawnCommand("node", [portalScript], {
      env: {
        ...sandboxEnv,
        PORT: String(sandbox.ports.portal),
      },
      prefix: "portal",
    });
    children.push(portal);
  }

  for (const definition of selectedProcesses) {
    if (definition.port) {
      await assertSandboxPortAvailable(definition.port, definition.name);
    }

    const invocation = definition.command
      ? { command: definition.command, args: definition.args ?? [] }
      : buildPackageManagerInvocation(["--filter", definition.workspace, "run", definition.script ?? "dev"]);
    const child = spawnCommand(invocation.command, invocation.args, {
      cwd: definition.cwd ? path.resolve(rootDir, definition.cwd) : undefined,
      env: buildPlatformChildEnvironment(process.env, definition.env),
      inheritEnv: false,
      prefix: definition.name,
    });
    lifecycleRecorder?.observe(definition.name, child);

    child.on("error", (error) => {
      if (!shuttingDown) {
        console.error(`[${definition.name}] Failed to start: ${error.message}`);
        shutdown(definition.name, 1);
      }
    });

    child.on("exit", (code) => {
      if (!shuttingDown) {
        console.error(`[${definition.name}] exited unexpectedly with code ${code ?? "unknown"}.`);
        shutdown(definition.name, code && code > 0 ? code : 1);
      }
    });

    children.push(child);
  }
}

async function runDown() {
  prefixedConsole("dev", `Stopping sandbox ${sandbox.id}...`);
  await stopComposePostgresCleanly({
    invocation: dockerComposeInvocation,
    env: sandboxEnv,
    run: runCommand,
    observe: (observation) => prefixedConsole("postgres", observation),
  });
}

async function runRefresh(targetName = "all") {
  if (replayRepresentativeRefresh && !representativeRefresh) {
    throw new Error("--replay requires --representative.");
  }
  prefixedConsole("dev", `Destroying sandbox ${sandbox.id} Postgres data...`);
  await runCommand(dockerComposeInvocation.command, [...dockerComposeInvocation.args, "down", "-v"], {
    env: sandboxEnv,
    prefix: "docker",
  });

  if (representativeRefresh) {
    if (replayRepresentativeRefresh) {
      process.env.PLATFORM_DATA_PROFILES = "critical-bootstrap,catalog-integration-bootstrap,representative-catalog";
      await runBootstrap(targetName);
      return;
    }

    process.env.PLATFORM_DATA_PROFILES = "critical-bootstrap,catalog-integration-bootstrap";
    await runBootstrap(targetName);
    prefixedConsole("dev", "Restoring a compatible representative Catalog snapshot set...");
    await runCommand("node", [fileURLToPath(new URL("./representative-snapshot.mjs", import.meta.url)), "restore"], {
      env: buildRepresentativeSnapshotCommandEnvironment(process.env, sandboxEnv),
      inheritEnv: false,
      prefix: "representative-snapshot",
    });
    return;
  }

  await runBootstrap(targetName);
}

function resolveDockerComposeInvocation(dockerComposeArgs) {
  const standaloneComposeArgs = dockerComposeArgs[0] === "compose" ? dockerComposeArgs.slice(1) : dockerComposeArgs;

  if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0) {
    return { command: "docker", args: dockerComposeArgs };
  }

  if (spawnSync("docker-compose", ["--version"], { stdio: "ignore" }).status === 0) {
    return { command: "docker-compose", args: standaloneComposeArgs };
  }

  return { command: "docker", args: dockerComposeArgs };
}

try {
  if (mode === "dev") {
    await runDev(target);
  } else if (mode === "bootstrap") {
    await runBootstrap(target);
  } else if (mode === "down") {
    await runDown();
  } else if (mode === "refresh") {
    await runRefresh(target);
  } else {
    console.error(`Unknown mode "${mode}". Use dev, bootstrap, down, or refresh.`);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
