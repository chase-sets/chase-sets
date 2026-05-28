import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readEnvFile } from "./lib/env.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";
import { syncLocalEnvFiles } from "./local-env.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const inheritedEnvKeys = new Set(Object.keys(process.env));
const testEnvFiles = [".env", ".env.local", ".env.test", ".env.test.local"];

export function loadTestEnvironment({
  env = process.env,
  envRootDir = rootDir,
  includeTestDatabaseUrl = true,
  inheritedKeys = inheritedEnvKeys,
  syncEnvFiles = syncLocalEnvFiles,
  ensureSandboxEnvironment = ensureWorktreeSandboxEnvironment,
} = {}) {
  syncEnvFiles({ command: "sync" });

  for (const fileName of testEnvFiles) {
    const values = readEnvFile(path.join(envRootDir, fileName));

    for (const [key, value] of Object.entries(values)) {
      if (key === "TEST_DATABASE_URL" && !includeTestDatabaseUrl && !inheritedKeys.has(key)) {
        continue;
      }

      if (!inheritedKeys.has(key)) {
        env[key] = value;
      }
    }
  }

  const { env: sandboxEnv } = ensureSandboxEnvironment({ rootDir: envRootDir, env });
  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (key === "TEST_DATABASE_URL" && !includeTestDatabaseUrl && !inheritedKeys.has(key)) {
      continue;
    }

    if (!inheritedKeys.has(key)) {
      env[key] = value;
    }
  }
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseRunWorkspacesArgs(argv) {
  const [scriptName, ...rawArgs] = argv;

  if (!scriptName) {
    throw new Error("Usage: node ./scripts/run-workspaces.mjs <script-name>");
  }

  const passthroughSeparatorIndex = rawArgs.indexOf("--");
  const runnerArgs = passthroughSeparatorIndex === -1 ? rawArgs : rawArgs.slice(0, passthroughSeparatorIndex);
  const passthroughArgs = passthroughSeparatorIndex === -1 ? [] : rawArgs.slice(passthroughSeparatorIndex + 1);

  const concurrencyArg = runnerArgs.find((arg) => arg.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? parsePositiveInteger(concurrencyArg.split("=")[1] ?? "", "--concurrency") : 1;
  const includeTestProfile = runnerArgs.find((arg) => arg.startsWith("--test-profile="))?.split("=")[1];
  const excludeTestProfile = runnerArgs.find((arg) => arg.startsWith("--exclude-test-profile="))?.split("=")[1];
  const workspaceNames = new Set(
    runnerArgs
      .filter((arg) => arg.startsWith("--workspace="))
      .map((arg) => arg.slice("--workspace=".length))
      .concat(
        runnerArgs
          .find((arg) => arg.startsWith("--workspace-list="))
          ?.slice("--workspace-list=".length)
          .split(",") ?? [],
      )
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return {
    scriptName,
    passthroughArgs,
    includeTestProfile,
    excludeTestProfile,
    workspaceNames,
    concurrency,
  };
}

function filterWorkspaces(workspaces, options) {
  const { scriptName, includeTestProfile, excludeTestProfile, workspaceNames } = options;

  return workspaces.filter((workspace) => {
    if (workspaceNames?.size > 0 && !workspaceNames.has(workspace.name)) {
      return false;
    }

    if (typeof workspace.packageJson.scripts?.[scriptName] !== "string") {
      return false;
    }

    const testProfile = workspace.packageJson.chaseSets?.testProfile;
    if (includeTestProfile && testProfile !== includeTestProfile) {
      return false;
    }

    if (excludeTestProfile && testProfile === excludeTestProfile) {
      return false;
    }

    return true;
  });
}

async function runWorkspace(workspace, options) {
  const { buildInvocation, passthroughArgs, run, scriptName, usePrefixedLogs } = options;

  console.log(`Running ${scriptName} in ${workspace.name}...`);
  const invocation = buildInvocation(["--filter", workspace.name, "run", scriptName, ...passthroughArgs]);
  await run(invocation.command, invocation.args, {
    ...(usePrefixedLogs ? { prefix: workspace.name } : { stdio: "inherit" }),
  });
}

async function runConcurrent(workspaces, options) {
  const failures = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < workspaces.length) {
      const workspace = workspaces[nextIndex];
      nextIndex += 1;

      try {
        await runWorkspace(workspace, options);
      } catch (error) {
        failures.push({
          workspace,
          error,
        });
      }
    }
  }

  const workerCount = Math.min(options.concurrency, workspaces.length);
  if (workerCount === 0) {
    console.log(`No workspaces matched ${options.scriptName}.`);
    return;
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    const failedNames = failures.map((failure) => failure.workspace.name).join(", ");
    console.error(`Failed workspaces: ${failedNames}`);
    for (const failure of failures) {
      console.error(
        `[${failure.workspace.name}] ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    }
    throw new Error(`${failures.length} workspace script run(s) failed.`);
  }
}

export async function runWorkspaceScripts(options) {
  const {
    argv,
    buildInvocation = buildPackageManagerInvocation,
    listWorkspaces = listWorkspacePackages,
    loadEnvironment = loadTestEnvironment,
    run = runCommand,
  } = options;
  const parsed = parseRunWorkspacesArgs(argv);

  if (parsed.scriptName.startsWith("test")) {
    const includeTestDatabaseUrl =
      parsed.scriptName === "test:db" || (parsed.scriptName === "test" && parsed.excludeTestProfile !== "db");
    loadEnvironment({
      includeTestDatabaseUrl,
    });
  }

  const workspaces = filterWorkspaces(listWorkspaces(), parsed);

  await runConcurrent(workspaces, {
    ...parsed,
    buildInvocation,
    run,
    usePrefixedLogs: parsed.concurrency > 1,
  });
}

async function main() {
  await runWorkspaceScripts({ argv: process.argv.slice(2) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
