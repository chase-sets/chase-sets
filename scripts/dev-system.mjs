import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
const target = process.argv[3] ?? "all";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const stripeCliScript = fileURLToPath(new URL("./stripe-cli.mjs", import.meta.url));
const dockerComposeArgs = ["compose", "-f", "docker-compose.dev.yml"];
const databaseUrl = "postgresql://catalog:catalog@localhost:5432/catalog";
const marketplaceApiEnvExamplePath = path.join(
  rootDir,
  "deployables",
  "marketplace-api",
  ".env.example",
);
const marketplaceApiEnvLocalPath = path.join(
  rootDir,
  "deployables",
  "marketplace-api",
  ".env.local",
);
const stripeReadyTimeoutMs = 20_000;

const bootstrapWorkspaces = [
  "@chase-sets/identity-api",
  "@chase-sets/catalog-api",
  "@chase-sets/inventory-api",
  "@chase-sets/marketplace-api",
];

const processes = [
  {
    name: "showcase",
    workspace: "@chase-sets/design-system-showcase",
    env: {},
    port: 6171,
  },
  {
    name: "identity-api",
    workspace: "@chase-sets/identity-api",
    env: {
      DATABASE_URL: databaseUrl,
      PORT: "6181",
    },
    port: 6181,
  },
  {
    name: "catalog-api",
    workspace: "@chase-sets/catalog-api",
    env: {
      DATABASE_URL: databaseUrl,
      IDENTITY_API_BASE_URL: "http://localhost:6181",
      PORT: "6180",
    },
    port: 6180,
  },
  {
    name: "marketplace-api",
    workspace: "@chase-sets/marketplace-api",
    env: {
      DATABASE_URL: databaseUrl,
      PORT: "6182",
    },
    port: 6182,
  },
  {
    name: "inventory-api",
    workspace: "@chase-sets/inventory-api",
    env: {
      DATABASE_URL: databaseUrl,
      IDENTITY_API_BASE_URL: "http://localhost:6181",
      PORT: "6183",
    },
    port: 6183,
  },
  {
    name: "catalog-admin",
    workspace: "@chase-sets/catalog-admin",
    env: {},
    port: 6172,
  },
  {
    name: "marketplace",
    workspace: "@chase-sets/marketplace",
    env: {},
    port: 6173,
  },
  {
    name: "identity-admin",
    workspace: "@chase-sets/identity-admin",
    env: {},
    port: 6174,
  },
];

const devTargets = {
  all: processes.map(({ name }) => name),
  "catalog-admin": ["identity-api", "catalog-api", "catalog-admin"],
  "identity-admin": ["identity-api", "identity-admin"],
  "marketplace-full": ["identity-api", "marketplace-api", "inventory-api", "marketplace"],
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
  const envExample = readEnvFile(marketplaceApiEnvExamplePath);
  const envLocal = readEnvFile(marketplaceApiEnvLocalPath);

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
}

async function runBootstrap() {
  await ensureDevDatabase();

  for (const workspace of bootstrapWorkspaces) {
    prefixedConsole("bootstrap", `Running ${workspace} bootstrap...`);
    const invocation = buildNpmInvocation([
      "run",
      "bootstrap",
      "--workspace",
      workspace,
    ]);
    await runCommand(invocation.command, invocation.args, {
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

  const marketplaceApiDefinition = selectedProcesses.find(
    (definition) => definition.name === "marketplace-api",
  );
  let shouldSkipManagedStripeStartup = false;

  if (marketplaceApiDefinition) {
    const marketplaceApiPortBusy =
      (await hasExistingListener(marketplaceApiDefinition.port)) ||
      !(await isPortAvailable(marketplaceApiDefinition.port));

    if (marketplaceApiPortBusy) {
      shouldSkipManagedStripeStartup = true;
      prefixedConsole(
        "dev",
        "Skipping managed Stripe startup because marketplace-api is already running or port 6182 is unavailable.",
      );
    } else {
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
            "Stripe listener is ready. marketplace-api will start with the current webhook secret.",
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
          "Stripe keys are incomplete in deployables/marketplace-api/.env.local, so marketplace-api will use the fake payment processor.",
        );
      }
    }
  }

  if (targetName === "all") {
    if (!(await hasExistingListener(6170)) && await isPortAvailable(6170)) {
      const portalScript = fileURLToPath(new URL("./dev-portal.mjs", import.meta.url));
      const portal = spawnCommand("node", [portalScript], {
        env: { PORT: "6170" },
        prefix: "portal",
      });
      children.push(portal);
    } else {
      prefixedConsole("dev", "Skipping portal because port 6170 is already in use.");
    }
  }

  for (const definition of selectedProcesses) {
    if (definition.name === "marketplace-api" && shouldSkipManagedStripeStartup) {
      prefixedConsole(
        "dev",
        `Skipping ${definition.name} because port ${definition.port} is already in use.`,
      );
      continue;
    }

    if (
      definition.port &&
      ((await hasExistingListener(definition.port)) ||
        !(await isPortAvailable(definition.port)))
    ) {
      prefixedConsole(
        "dev",
        `Skipping ${definition.name} because port ${definition.port} is already in use.`,
      );
      continue;
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

  if (children.length === 0) {
    prefixedConsole(
      "dev",
      "All local dev services are already running. Reusing the existing stack.",
    );
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

