import process from "node:process";
import { buildNpmInvocation, runCommand } from "./lib/process.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";

async function main() {
  const [scriptName, ...rawArgs] = process.argv.slice(2);

  if (!scriptName) {
    throw new Error("Usage: node ./scripts/run-workspaces.mjs <script-name>");
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
    const invocation = buildNpmInvocation([
      "run",
      scriptName,
      "--workspace",
      workspace.name,
      ...(passthroughArgs.length > 0 ? ["--", ...passthroughArgs] : []),
    ]);
    await runCommand(invocation.command, invocation.args, { stdio: "inherit" });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
