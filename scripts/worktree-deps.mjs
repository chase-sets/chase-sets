import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { repoRoot } from "./lib/repo.mjs";

const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageManager = packageJson.packageManager ?? "pnpm@11.0.9";
const pnpmVersion = packageManager.startsWith("pnpm@") ? packageManager.slice("pnpm@".length) : "11.0.9";

function resolveStoreDirOverride() {
  const override = process.env.CHASE_SETS_PNPM_STORE_DIR;
  return override ? path.resolve(override) : null;
}

function storeDirArgs() {
  const override = resolveStoreDirOverride();
  return override ? ["--store-dir", override] : [];
}

function describeStoreDir() {
  const override = resolveStoreDirOverride();
  if (override) {
    return `${override} (CHASE_SETS_PNPM_STORE_DIR)`;
  }

  const invocation = buildPnpmInvocation(["store", "path"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  return result.status === 0 ? `${result.stdout.trim()} (pnpm per-drive default)` : "pnpm default (unresolved)";
}

function resolveWindowsNpmCliPath() {
  const candidates = [
    process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath) ? process.env.npm_execpath : null,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js") : null,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function buildNpmExecPnpmInvocation(args) {
  const npmArgs = ["exec", "--yes", `pnpm@${pnpmVersion}`, "--", ...args];

  if (process.platform === "win32") {
    const npmCliPath = resolveWindowsNpmCliPath();
    if (npmCliPath) {
      return {
        command: process.execPath,
        args: [npmCliPath, ...npmArgs],
      };
    }
  }

  return {
    command: "npm",
    args: npmArgs,
  };
}

function commandWorks(invocation) {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  return result.status === 0;
}

function buildPnpmInvocation(args) {
  const directInvocation = buildPackageManagerInvocation(args);
  if (commandWorks(buildPackageManagerInvocation(["--version"]))) {
    return directInvocation;
  }

  return buildNpmExecPnpmInvocation(args);
}

async function runPnpm(args) {
  const invocation = buildPnpmInvocation(args);
  await runCommand(invocation.command, invocation.args, { stdio: "inherit" });
}

function readPnpmVersion() {
  const invocation = buildPnpmInvocation(["--version"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    return "unavailable";
  }

  return result.stdout.trim();
}

function printStatus() {
  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const nodeModulesPath = path.join(repoRoot, "node_modules");
  const ready = existsSync(lockfilePath) && existsSync(nodeModulesPath);

  console.log(`Repo root: ${repoRoot}`);
  console.log(`Node: ${process.version}`);
  console.log(`Package manager: pnpm@${readPnpmVersion()}`);
  console.log(`pnpm store: ${describeStoreDir()}`);
  console.log(`Lockfile: ${existsSync(lockfilePath) ? "present" : "missing"}`);
  console.log(`node_modules: ${existsSync(nodeModulesPath) ? "present" : "missing"}`);
  console.log(`Worktree ready: ${ready ? "yes" : "no"}`);

  return ready;
}

async function install() {
  const override = resolveStoreDirOverride();
  if (override) {
    mkdirSync(override, { recursive: true });
  }
  await runPnpm(["install", "--frozen-lockfile", "--prefer-offline", ...storeDirArgs()]);
  printStatus();
}

async function pruneStore() {
  await runPnpm(["store", "prune", ...storeDirArgs()]);
}

function printHelp() {
  console.log(`Usage: node ./scripts/worktree-deps.mjs <install|doctor|prune-store>`);
}

async function main() {
  const command = process.argv[2] ?? "doctor";

  if (command === "install") {
    await install();
    return;
  }

  if (command === "doctor") {
    const ready = printStatus();
    process.exitCode = ready ? 0 : 1;
    return;
  }

  if (command === "prune-store") {
    await pruneStore();
    return;
  }

  printHelp();
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
