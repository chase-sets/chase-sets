import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readEnvFile } from "./lib/env.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { syncLocalEnvFiles } from "./local-env.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const inheritedEnvKeys = new Set(Object.keys(process.env));
const testEnvFiles = [".env", ".env.local", ".env.test", ".env.test.local"];

function loadTestEnvironment() {
  syncLocalEnvFiles({ command: "sync" });

  for (const fileName of testEnvFiles) {
    const values = readEnvFile(path.join(rootDir, fileName));

    for (const [key, value] of Object.entries(values)) {
      if (!inheritedEnvKeys.has(key)) {
        process.env[key] = value;
      }
    }
  }
}

async function main() {
  const [scriptName, ...rawArgs] = process.argv.slice(2);

  if (!scriptName) {
    throw new Error("Usage: node ./scripts/run-workspaces.mjs <script-name>");
  }

  if (scriptName.startsWith("test")) {
    loadTestEnvironment();
  }

  const passthroughSeparatorIndex = rawArgs.indexOf("--");
  const runnerArgs =
    passthroughSeparatorIndex === -1 ? rawArgs : rawArgs.slice(0, passthroughSeparatorIndex);
  const passthroughArgs =
    passthroughSeparatorIndex === -1 ? [] : rawArgs.slice(passthroughSeparatorIndex + 1);

  const includeTestProfile = runnerArgs
    .find((arg) => arg.startsWith("--test-profile="))
    ?.split("=")[1];
  const excludeTestProfile = runnerArgs
    .find((arg) => arg.startsWith("--exclude-test-profile="))
    ?.split("=")[1];

  const workspaces = listWorkspacePackages().filter((workspace) => {
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

  for (const workspace of workspaces) {
    console.log(`Running ${scriptName} in ${workspace.name}...`);
    const invocation = buildPackageManagerInvocation([
      "--filter",
      workspace.name,
      "run",
      scriptName,
      ...(passthroughArgs.length > 0 ? ["--", ...passthroughArgs] : []),
    ]);
    await runCommand(invocation.command, invocation.args, { stdio: "inherit" });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
