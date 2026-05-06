import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const mode = process.argv[2] ?? "dev";
const target = process.argv[3] ?? "all";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const stripeCliScript = fileURLToPath(new URL("./stripe-cli.mjs", import.meta.url));
const dockerComposeArgs = ["compose", "-f", "docker-compose.dev.yml"];
const localAdminDatabaseUrl =
  process.env.POSTGRES_DEV_ADMIN_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
const devDatabaseName = process.env.POSTGRES_DEV_DATABASE_NAME ?? "chase_sets";
const devDatabaseUrl = (() => {
  if (process.env.POSTGRES_DEV_DATABASE_URL) {
    return process.env.POSTGRES_DEV_DATABASE_URL;
  }

  const url = new URL(localAdminDatabaseUrl);
  url.pathname = `/${devDatabaseName}`;
  return url.toString();
})();
const requiredExtensions = ["vector"];
const platformApiEnvExamplePath = path.join(
  rootDir,
  "deployables",
  "platform-api",
  ".env.example",
);
const platformApiEnvLocalPath = path.join(
  rootDir,
  "deployables",
  "platform-api",
  ".env.local",
);
const stripeReadyTimeoutMs = 20_000;
const postgresReadyTimeoutMs = 30_000;
const postgresReadyPollMs = 1_000;

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

async function ensurePlatformDatabase(adminPool) {
  const databaseExists = await adminPool.query(
    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [devDatabaseName],
  );

  if (!databaseExists.rows[0]?.exists) {
    await adminPool.query(`CREATE DATABASE ${escapeIdentifier(devDatabaseName)}`);
  }
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
    await ensurePlatformDatabase(adminPool);
  });

  await withAdminPool(async (adminPool) => {
    for (const extensionName of requiredExtensions) {
      await adminPool.query(
        `CREATE EXTENSION IF NOT EXISTS ${escapeIdentifier(extensionName)}`,
      );
    }
  }, devDatabaseName);
}

const bootstrapWorkspaces = [
  "@chase-sets/app-platform-api",
  "@chase-sets/app-platform-worker",
];

const processes = [
  {
    name: "platform-api",
    workspace: "@chase-sets/app-platform-api",
    env: {
      DATABASE_URL: devDatabaseUrl,
      PLATFORM_CONTROL_DATABASE_URL: devDatabaseUrl,
      PORT: "6182",
    },
    port: 6182,
  },
  {
    name: "platform-worker",
    workspace: "@chase-sets/app-platform-worker",
    env: {
      DATABASE_URL: devDatabaseUrl,
      PLATFORM_CONTROL_DATABASE_URL: devDatabaseUrl,
      PORT: "6183",
    },
    port: 6183,
  },
  {
    name: "admin-web",
    workspace: "@chase-sets/app-admin-web",
    env: {},
    port: 6172,
  },
  {
    name: "marketplace",
    workspace: "@chase-sets/app-marketplace-web",
    env: {},
    port: 6173,
  },
];

const devTargets = {
  all: processes.map(({ name }) => name),
  "admin-web": ["platform-api", "platform-worker", "admin-web"],
  "marketplace-full": ["platform-api", "platform-worker", "marketplace"],
};

function resolveProcessesForTarget(targetName) {
  const processNames = devTargets[targetName];

  if (!processNames) {
    throw new Error(
      `Unknown dev target "${targetName}". Use one of: ${Object.keys(devTargets).join(", ")}.`,
    );
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

function wirePrefixedStream(stream, prefix) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.length > 0) {
        console.log(`[${prefix}] ${part}`);
      }
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      console.log(`[${prefix}] ${buffer}`);
    }
  });
}

function spawnCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      ...options.env,
    },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  if (options.prefix && child.stdout && child.stderr) {
    wirePrefixedStream(child.stdout, options.prefix);
    wirePrefixedStream(child.stderr, options.prefix);
  }

  return child;
}

function buildNpmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`],
    };
  }

  return {
    command: "npm",
    args,
  };
}

function parseEnvFile(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    values[key] = value;
  }

  return values;
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  return parseEnvFile(readFileSync(filePath, "utf8"));
}

function resolveMarketplaceStripeConfig() {
  const envExample = readEnvFile(platformApiEnvExamplePath);
  const envLocal = readEnvFile(platformApiEnvLocalPath);

  return {
    secretKey:
      process.env.STRIPE_SECRET_KEY ??
      envLocal.STRIPE_SECRET_KEY ??
      envExample.STRIPE_SECRET_KEY ??
      "",
    publishableKey:
      process.env.STRIPE_PUBLISHABLE_KEY ??
      envLocal.STRIPE_PUBLISHABLE_KEY ??
      envExample.STRIPE_PUBLISHABLE_KEY ??
      "",
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

  throw new Error(
    `Stripe listener did not report a webhook secret within ${stripeReadyTimeoutMs / 1000} seconds.`,
  );
}

function isPortInUseError(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EADDRINUSE" || error.code === "EACCES")
  );
}

function isConnectionRefusedError(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ECONNREFUSED" ||
      error.code === "EHOSTUNREACH" ||
      error.code === "ETIMEDOUT")
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
      throw new Error(
        `Unable to inspect listeners on port ${port}: ${result.stderr?.trim() || "unknown error"}`,
      );
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
    throw new Error(
      `Unable to inspect listeners on port ${port}: ${result.stderr?.trim() || "unknown error"}`,
    );
  }

  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await sleep(100);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
        return true;
      }

      throw error;
    }
  }

  return false;
}

async function terminateProcessIds(pids, label) {
  const uniquePids = Array.from(
    new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)),
  );

  if (uniquePids.length === 0) {
    return false;
  }

  prefixedConsole(
    "dev",
    `Restarting ${label} by stopping listener${uniquePids.length === 1 ? "" : "s"} on PID${uniquePids.length === 1 ? "" : "s"} ${uniquePids.join(", ")}.`,
  );

  for (const pid of uniquePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }

  for (const pid of uniquePids) {
    const exited = await waitForProcessExit(pid, 3_000);
    if (!exited) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
          throw error;
        }
      }
      await waitForProcessExit(pid, 2_000);
    }
  }

  return true;
}

async function restartExistingListener(port, label) {
  const hasListener = (await hasExistingListener(port)) || !(await isPortAvailable(port));
  if (!hasListener) {
    return false;
  }

  const pids = listListeningProcessIds(port);
  await terminateProcessIds(pids, label);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) {
      return true;
    }
    await sleep(100);
  }

  throw new Error(`Unable to restart ${label}: port ${port} is still in use.`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, options);

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

async function ensureDevDatabase() {
  prefixedConsole("dev", "Starting shared Postgres...");
  await runCommand("docker", [...dockerComposeArgs, "up", "-d"], {
    prefix: "docker",
  });
  prefixedConsole("dev", `Provisioning shared Postgres database '${devDatabaseName}'...`);
  await preparePlatformDatabase();
}

async function runBootstrap() {
  await ensureDevDatabase();

  for (const workspace of bootstrapWorkspaces) {
    prefixedConsole("bootstrap", `Running ${workspace} bootstrap...`);
    const processDefinition = processes.find(
      (definition) => definition.workspace === workspace,
    );
    const invocation = buildNpmInvocation([
      "run",
      "bootstrap",
      "--workspace",
      workspace,
    ]);
    await runCommand(invocation.command, invocation.args, {
      env: processDefinition?.env ?? {},
      prefix: workspace.replace("@chase-sets/", ""),
    });
  }
}

function printDevUrls(targetName, selectedProcesses, includePortal = false) {
  console.log("");
  console.log(
    targetName === "all"
      ? "Local dev system"
      : `Local dev stack: ${targetName}`,
  );

  if (includePortal) {
    console.log("  Dev Portal:      http://localhost:6170");
  }

  for (const definition of selectedProcesses) {
    console.log(
      `  ${definition.name.padEnd(16)} http://localhost:${definition.port}`,
    );
  }

  console.log("");
}

async function runDev(targetName = "all") {
  await runBootstrap();
  const selectedProcesses = resolveProcessesForTarget(targetName);
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
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }

    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
    }, 3_000).unref();

    setTimeout(() => process.exit(exitCode), 100).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT", 0));
  process.once("SIGTERM", () => shutdown("SIGTERM", 0));

  const platformApiDefinition = selectedProcesses.find(
    (definition) => definition.name === "platform-api",
  );

  if (platformApiDefinition) {
    await restartExistingListener(
      platformApiDefinition.port,
      platformApiDefinition.name,
    );

    const stripeConfig = resolveMarketplaceStripeConfig();

    if (stripeConfig.secretKey && stripeConfig.publishableKey) {
      const readyFilePath = path.join(
        os.tmpdir(),
        `chase-sets-stripe-ready-${process.pid}-${Date.now()}.txt`,
      );
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
          console.error(
            `[stripe] exited unexpectedly with code ${code ?? "unknown"}.`,
          );
          shutdown("stripe", code ?? 1);
        }
      });

      children.push(stripeListener);

      try {
        await waitForStripeReady(readyFilePath, stripeListener);
        prefixedConsole(
          "dev",
          "Stripe listener is ready. platform-api will start with the current webhook secret.",
        );
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
    await restartExistingListener(6170, "portal");
    const portalScript = fileURLToPath(new URL("./dev-portal.mjs", import.meta.url));
    const portal = spawnCommand("node", [portalScript], {
      env: { PORT: "6170" },
      prefix: "portal",
    });
    children.push(portal);
  }

  for (const definition of selectedProcesses) {
    if (definition.port) {
      await restartExistingListener(definition.port, definition.name);
    }

    const invocation = buildNpmInvocation([
      "run",
      "dev",
      "--workspace",
      definition.workspace,
    ]);
    const child = spawnCommand(invocation.command, invocation.args, {
      env: definition.env,
      prefix: definition.name,
    });

    child.on("error", (error) => {
      if (!shuttingDown) {
        console.error(`[${definition.name}] Failed to start: ${error.message}`);
        shutdown(definition.name, 1);
      }
    });

    child.on("exit", (code) => {
      if (!shuttingDown && code !== 0) {
        console.error(
          `[${definition.name}] exited unexpectedly with code ${code ?? "unknown"}.`,
        );
        shutdown(definition.name, code ?? 1);
      }
    });

    children.push(child);
  }
}

async function runDown() {
  prefixedConsole("dev", "Stopping shared Postgres...");
  await runCommand("docker", [...dockerComposeArgs, "down"], {
    prefix: "docker",
  });
}

async function runRefresh() {
  prefixedConsole("dev", "Destroying shared Postgres data...");
  await runCommand("docker", [...dockerComposeArgs, "down", "-v"], {
    prefix: "docker",
  });
  await runBootstrap();
}

try {
  if (mode === "dev") {
    await runDev(target);
  } else if (mode === "bootstrap") {
    await runBootstrap();
  } else if (mode === "down") {
    await runDown();
  } else if (mode === "refresh") {
    await runRefresh();
  } else {
    console.error(`Unknown mode "${mode}". Use dev, bootstrap, down, or refresh.`);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

