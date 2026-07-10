import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { loadTestEnvironment } from "./run-workspaces.mjs";

// Runs the non-DB test tier as a single vitest projects-mode process.
// Mirrors the environment loading run-workspaces performs for
// `test --exclude-test-profile=db` and `test:unit --test-profile=db`:
// TEST_DATABASE_URL stays out unless inherited from the caller.
export async function runVitestProjects(options = {}) {
  const {
    argv = [],
    buildInvocation = buildPackageManagerInvocation,
    loadEnvironment = loadTestEnvironment,
    run = runCommand,
  } = options;

  loadEnvironment({ includeTestDatabaseUrl: false });

  // pnpm forwards the `--` separator from `pnpm run verify:test -- <args>`.
  const passthroughArgs = argv[0] === "--" ? argv.slice(1) : argv;
  const invocation = buildInvocation([
    "exec",
    "vitest",
    "run",
    "--config",
    "./vitest.projects.config.mjs",
    ...passthroughArgs,
  ]);
  await run(invocation.command, invocation.args, { stdio: "inherit" });
}

async function main() {
  await runVitestProjects({ argv: process.argv.slice(2) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
