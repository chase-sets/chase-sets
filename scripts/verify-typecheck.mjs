import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  return {
    workspaceArgs: args.filter((arg) => arg.startsWith("--workspace=") || arg.startsWith("--workspace-list=")),
  };
}

async function runPackageManager(args) {
  const invocation = buildPackageManagerInvocation(args);
  await runCommand(invocation.command, invocation.args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

export async function verifyTypecheck(argv = process.argv.slice(2)) {
  const { workspaceArgs } = parseArgs(argv);

  await runPackageManager(["run", "check:no-any"]);
  await runPackageManager(["exec", "tsc", "-p", "./tsconfig.json", "--noEmit"]);
  await runPackageManager(["run", "test:typecheck"]);

  const workspaceTypecheckArgs = ["./scripts/run-workspaces.mjs", "typecheck", "--concurrency=4", ...workspaceArgs];
  await runCommand(process.execPath, workspaceTypecheckArgs, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyTypecheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
