import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const workspaceRoots = ["bounded-contexts", "contracts", "infrastructure", "packages", "deployables"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
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

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      },
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function listWorkspacePackages() {
  const packages = [];

  for (const workspaceRoot of workspaceRoots) {
    const rootPath = path.join(repoRoot, workspaceRoot);

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageJsonPath = path.join(rootPath, entry.name, "package.json");

      try {
        const packageJson = readJson(packageJsonPath);
        packages.push({
          name: packageJson.name,
          scripts: packageJson.scripts ?? {},
          chaseSets: packageJson.chaseSets ?? {},
        });
      } catch {
        // Ignore non-package directories.
      }
    }
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const [scriptName, ...rawArgs] = process.argv.slice(2);

  if (!scriptName) {
    throw new Error("Usage: node ./scripts/run-workspaces.mjs <script-name>");
  }

  const includeTestProfile = rawArgs
    .find((arg) => arg.startsWith("--test-profile="))
    ?.split("=")[1];
  const excludeTestProfile = rawArgs
    .find((arg) => arg.startsWith("--exclude-test-profile="))
    ?.split("=")[1];

  const workspaces = listWorkspacePackages().filter((workspace) => {
    if (typeof workspace.scripts[scriptName] !== "string") {
      return false;
    }

    const testProfile = workspace.chaseSets?.testProfile;
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
    const invocation = buildNpmInvocation(["run", scriptName, "--workspace", workspace.name]);
    await runCommand(invocation.command, invocation.args);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
