import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  applySandboxEnv,
  buildDockerComposeArgs,
  buildSandboxEnv,
  ensureWorktreeSandboxEnvironment,
  resolveWorktreeSandbox,
} from "./lib/sandbox.mjs";
import { stopComposePostgresCleanly } from "./lib/postgres-compose-lifecycle.mjs";

const command = process.argv[2] ?? "doctor";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const { sandbox, env: sandboxEnv } = ensureWorktreeSandboxEnvironment({ rootDir });
applySandboxEnv(sandboxEnv);

function printUsage() {
  console.log("Usage:");
  console.log("  node ./scripts/sandbox.mjs doctor      # print current sandbox details");
  console.log("  node ./scripts/sandbox.mjs env         # print generated sandbox env");
  console.log("  node ./scripts/sandbox.mjs compose     # print Docker Compose project details");
  console.log("  node ./scripts/sandbox.mjs down        # stop current sandbox containers");
  console.log("  node ./scripts/sandbox.mjs clean       # stop current sandbox and remove volumes");
  console.log("  node ./scripts/sandbox.mjs list        # list Docker Compose projects");
  console.log("  node ./scripts/sandbox.mjs gc          # remove sandboxes whose worktree no longer exists");
  console.log("  node ./scripts/sandbox.mjs clean-all   # remove all chase-sets-* Compose projects");
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...sandboxEnv,
      ...options.env,
    },
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }

  return result.stdout ?? "";
}

function printDoctor() {
  console.log("");
  console.log(`Worktree sandbox: ${sandbox.id}`);
  console.log(`  Env file:        ${sandbox.envFilePath}`);
  console.log(`  Compose project: ${sandbox.composeProjectName}`);
  console.log(`  Port base:       ${sandbox.basePort}`);
  console.log("");
  console.log("Services");
  console.log(`  Dev portal:      ${sandbox.urls.portal}`);
  console.log(`  Admin web:       ${sandbox.urls.adminWeb}`);
  console.log(`  Marketplace:     ${sandbox.urls.marketplaceWeb}`);
  console.log(`  Public web:      ${sandbox.urls.publicWeb}`);
  console.log(`  Platform API:    ${sandbox.urls.platformApi}`);
  console.log(`  Platform worker: ${sandbox.urls.platformWorker}`);
  console.log("");
  console.log("Databases");
  console.log(`  Admin URL:       ${sandbox.adminDatabaseUrl}`);
  console.log(`  Control URL:     ${sandbox.controlDatabaseUrl}`);
  console.log(`  Context DBs:     ${sandbox.contextNames.length}`);
  console.log("");
  console.log("Observability");
  console.log(`  Grafana:         ${sandbox.urls.grafana}`);
  console.log(`  Prometheus:      ${sandbox.urls.prometheus}`);
  console.log(`  Loki:            ${sandbox.urls.loki}`);
  console.log(`  Tempo:           ${sandbox.urls.tempo}`);
  console.log(`  OTLP HTTP:       ${sandbox.urls.otelHttp}`);
  console.log(`  OTLP gRPC:       ${sandbox.urls.otelGrpc}`);
  console.log("");
}

function printEnv() {
  const env = buildSandboxEnv(sandbox);
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    console.log(`${key}=${value}`);
  }
}

function printCompose() {
  console.log(`COMPOSE_PROJECT_NAME=${sandbox.composeProjectName}`);
  console.log(`COMPOSE_ENV_FILE=${sandbox.envFilePath}`);
  console.log(`docker ${buildDockerComposeArgs(sandbox).join(" ")}`);
}

function composeDown(removeVolumes = false) {
  const invocation = {
    command: "docker",
    args: buildDockerComposeArgs(sandbox),
  };

  if (removeVolumes) {
    runDocker([...invocation.args, "down", "-v"]);
    return;
  }

  return stopComposePostgresCleanly({
    invocation,
    env: sandboxEnv,
    run: (_command, args, options) => runDocker(args, options),
    observe: (observation) => console.log(observation),
  });
}

function listComposeProjects() {
  runDocker(["compose", "ls"], { stdio: "inherit" });
}

function parseComposeProjects(output) {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => entry.Name ?? entry.name).filter((name) => typeof name === "string");
    }
  } catch {
    // Fall back to tabular parsing below.
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name.startsWith("chase-sets-"));
}

function cleanAllSandboxes() {
  const output = runDocker(["compose", "ls", "--format", "json"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const projectNames = parseComposeProjects(output).filter((name) => name.startsWith("chase-sets-"));

  if (projectNames.length === 0) {
    console.log("No chase-sets-* Compose projects found.");
    return;
  }

  for (const projectName of projectNames) {
    console.log(`Removing ${projectName}...`);
    runDocker([
      "compose",
      "--env-file",
      sandbox.envFilePath,
      "-f",
      "docker-compose.dev.yml",
      "-p",
      projectName,
      "down",
      "-v",
    ]);
  }
}

function listRegisteredWorktreePaths() {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function gcSandboxes() {
  // Project names hash the worktree path, so every registered worktree's
  // expected name is computable; anything else with our prefix is orphaned.
  const expected = new Set(
    listRegisteredWorktreePaths()
      .map((worktreePath) => {
        try {
          return resolveWorktreeSandbox({ rootDir: worktreePath, env: {}, contextNames: [] }).composeProjectName;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );

  const output = runDocker(["compose", "ls", "--all", "--format", "json"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const orphaned = parseComposeProjects(output)
    .filter((name) => name.startsWith("chase-sets-"))
    .filter((name) => !expected.has(name));

  if (orphaned.length === 0) {
    console.log("No orphaned chase-sets-* sandboxes found.");
    return;
  }

  for (const projectName of orphaned) {
    console.log(`Removing orphaned sandbox ${projectName}...`);
    runDocker([
      "compose",
      "--env-file",
      sandbox.envFilePath,
      "-f",
      "docker-compose.dev.yml",
      "-p",
      projectName,
      "down",
      "-v",
    ]);
  }
}

try {
  if (command === "doctor") {
    printDoctor();
  } else if (command === "env") {
    printEnv();
  } else if (command === "compose") {
    printCompose();
  } else if (command === "down") {
    await composeDown(false);
  } else if (command === "clean") {
    composeDown(true);
  } else if (command === "list") {
    listComposeProjects();
  } else if (command === "gc") {
    gcSandboxes();
  } else if (command === "clean-all") {
    cleanAllSandboxes();
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
