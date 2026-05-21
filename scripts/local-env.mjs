import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRootDir = fileURLToPath(new URL("../", import.meta.url));
const commands = new Set(["sync", "pull", "push", "check", "doctor", "path"]);

export function resolveDefaultEnvHome(env = process.env) {
  return path.resolve(
    env.CHASE_SETS_LOCAL_ENV_HOME ?? path.join(os.homedir(), ".config", "chase-sets", "env", "local"),
  );
}

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function targetLabel(target) {
  return toRepoPath(target.worktreeRelativePath);
}

function ensureParentDirectory(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readOptionalBuffer(filePath) {
  return existsSync(filePath) ? readFileSync(filePath) : null;
}

function filesEqual(leftPath, rightPath) {
  const left = readOptionalBuffer(leftPath);
  const right = readOptionalBuffer(rightPath);

  if (left === null || right === null) {
    return false;
  }

  return left.equals(right);
}

function copyFile(sourcePath, destinationPath) {
  ensureParentDirectory(destinationPath);
  copyFileSync(sourcePath, destinationPath);
}

function discoverDeployableEnvTargets(rootDir, envHome) {
  const deployablesDir = path.join(rootDir, "deployables");

  if (!existsSync(deployablesDir)) {
    return [];
  }

  return readdirSync(deployablesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const worktreeRelativePath = `deployables/${entry.name}/.env.local`;

      return {
        name: entry.name,
        kind: "deployable",
        examplePath: path.join(rootDir, "deployables", entry.name, ".env.example"),
        sharedPath: path.join(envHome, "deployables", entry.name, ".env.local"),
        worktreePath: path.join(rootDir, "deployables", entry.name, ".env.local"),
        worktreeRelativePath,
      };
    })
    .filter((target) => existsSync(target.examplePath))
    .sort((left, right) => targetLabel(left).localeCompare(targetLabel(right), "en"));
}

export function discoverEnvTargets({ rootDir = defaultRootDir, envHome = resolveDefaultEnvHome() } = {}) {
  const rootTestTarget = {
    name: "root test",
    kind: "test",
    examplePath: null,
    sharedPath: path.join(envHome, ".env.test.local"),
    worktreePath: path.join(rootDir, ".env.test.local"),
    worktreeRelativePath: ".env.test.local",
  };

  return [rootTestTarget, ...discoverDeployableEnvTargets(rootDir, envHome)];
}

function describeTarget(target) {
  const worktreeExists = existsSync(target.worktreePath);
  const sharedExists = existsSync(target.sharedPath);

  if (!worktreeExists && !sharedExists) {
    return {
      action: "none",
      changed: false,
      status: "unused",
      target,
    };
  }

  if (worktreeExists && !sharedExists) {
    return {
      action: "push",
      changed: true,
      status: "shared-missing",
      target,
    };
  }

  if (!worktreeExists && sharedExists) {
    return {
      action: "pull",
      changed: true,
      status: "worktree-missing",
      target,
    };
  }

  if (filesEqual(target.worktreePath, target.sharedPath)) {
    return {
      action: "none",
      changed: false,
      status: "current",
      target,
    };
  }

  const worktreeMtime = statSync(target.worktreePath).mtimeMs;
  const sharedMtime = statSync(target.sharedPath).mtimeMs;

  return {
    action: worktreeMtime >= sharedMtime ? "push" : "pull",
    changed: true,
    status: "drifted",
    target,
  };
}

function executeAction(plan, command) {
  if (command === "check" || command === "doctor" || plan.action === "none") {
    return plan;
  }

  if (command === "pull" && !existsSync(plan.target.sharedPath)) {
    return { ...plan, action: "none", changed: false };
  }

  if (command === "push" && !existsSync(plan.target.worktreePath)) {
    return { ...plan, action: "none", changed: false };
  }

  const action = command === "pull" || command === "push" ? command : plan.action;

  if (action === "pull") {
    copyFile(plan.target.sharedPath, plan.target.worktreePath);
  } else if (action === "push") {
    copyFile(plan.target.worktreePath, plan.target.sharedPath);
  }

  return { ...plan, action };
}

export function syncLocalEnvFiles({
  command = "sync",
  rootDir = defaultRootDir,
  envHome = resolveDefaultEnvHome(),
} = {}) {
  const targets = discoverEnvTargets({ rootDir, envHome });
  return targets.map((target) => executeAction(describeTarget(target), command));
}

function printUsage() {
  console.log("Usage:");
  console.log("  node ./scripts/local-env.mjs sync    # two-way sync, newer file wins");
  console.log("  node ./scripts/local-env.mjs pull    # copy shared env into this worktree");
  console.log("  node ./scripts/local-env.mjs push    # copy this worktree env into shared env");
  console.log("  node ./scripts/local-env.mjs check   # report drift without writing");
  console.log("  node ./scripts/local-env.mjs doctor  # detailed local env status");
  console.log("  node ./scripts/local-env.mjs path    # print shared env directory");
  console.log("");
  console.log("Environment:");
  console.log("  CHASE_SETS_LOCAL_ENV_HOME overrides the shared env directory.");
}

function formatResult(result) {
  const label = targetLabel(result.target);

  if (result.action === "pull") {
    return `hydrated ${label} from shared env`;
  }

  if (result.action === "push") {
    return `saved ${label} to shared env`;
  }

  if (result.status === "current") {
    return `current ${label}`;
  }

  return `unused ${label}`;
}

function hasCheckFailure(result) {
  return result.status === "shared-missing" || result.status === "worktree-missing" || result.status === "drifted";
}

function runCli() {
  const command = process.argv[2] ?? "sync";

  if (!commands.has(command)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const envHome = resolveDefaultEnvHome();

  if (command === "path") {
    console.log(envHome);
    return;
  }

  const results = syncLocalEnvFiles({ command, envHome });

  console.log(`Shared local env: ${envHome}`);

  for (const result of results) {
    if (command === "doctor" || result.changed || result.status === "current") {
      console.log(`  ${formatResult(result)}`);
    }
  }

  if (command === "check" && results.some(hasCheckFailure)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli();
}
