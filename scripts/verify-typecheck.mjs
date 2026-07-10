import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

async function runPackageManager(args) {
  const invocation = buildPackageManagerInvocation(args);
  await runCommand(invocation.command, invocation.args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

// The root tsconfig.json includes every workspace source file and
// tsconfig.tests.json includes every test file, so two incremental tsc passes
// cover the full graph without re-checking the same files per workspace.
// Workspace --workspace/--workspace-list arguments are accepted and ignored
// for CI compatibility.
export async function verifyTypecheck() {
  await runPackageManager(["run", "check:no-any"]);
  await runPackageManager(["exec", "tsc", "-p", "./tsconfig.json", "--noEmit"]);
  await runPackageManager(["run", "test:typecheck"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyTypecheck().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
