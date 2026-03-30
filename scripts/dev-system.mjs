import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const dockerComposeArgs = ["compose", "-f", "docker-compose.dev.yml"];
const databaseUrl = "postgresql://catalog:catalog@localhost:5432/catalog";

const bootstrapWorkspaces = [
  "@chase-sets/identity-api",
  "@chase-sets/catalog-api",
  "@chase-sets/marketplace-api",
];

const processes = [
  {
    name: "showcase",
    workspace: "@chase-sets/design-system-showcase",
    env: {},
  },
  {
    name: "identity-api",
    workspace: "@chase-sets/identity-api",
    env: {
      DATABASE_URL: databaseUrl,
      PORT: "3102",
    },
  },
  {
    name: "catalog-api",
    workspace: "@chase-sets/catalog-api",
    env: {
      DATABASE_URL: databaseUrl,
      IDENTITY_API_BASE_URL: "http://localhost:3102",
      PORT: "3100",
    },
  },
  {
    name: "marketplace-api",
    workspace: "@chase-sets/marketplace-api",
    env: {
      DATABASE_URL: databaseUrl,
      PORT: "3200",
    },
  },
  {
    name: "catalog-admin",
    workspace: "@chase-sets/catalog-admin",
    env: {},
  },
  {
    name: "marketplace",
    workspace: "@chase-sets/marketplace",
    env: {},
  },
  {
    name: "identity-admin",
    workspace: "@chase-sets/identity-admin",
    env: {},
  },
];

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

function printDevUrls() {
  console.log("");
  console.log("Local dev system");
  console.log("  Showcase:        http://localhost:5173");
  console.log("  Catalog Admin:   http://localhost:5174");
  console.log("  Marketplace:     http://localhost:5175");
  console.log("  Identity Admin:  http://localhost:5176");
  console.log("  Catalog API:     http://localhost:3100");
  console.log("  Identity API:    http://localhost:3102");
  console.log("  Marketplace API: http://localhost:3200");
  console.log("");
}

async function runDev() {
  await runBootstrap();
  printDevUrls();

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

  for (const definition of processes) {
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

try {
  if (mode === "dev") {
    await runDev();
  } else if (mode === "bootstrap") {
    await runBootstrap();
  } else if (mode === "down") {
    await runDown();
  } else {
    console.error(`Unknown mode "${mode}". Use dev, bootstrap, or down.`);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
