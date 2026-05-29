import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { e2eSuiteById, e2eSuites } from "./e2e-suites.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const suiteId = args[0];
  if (!suiteId) {
    throw new Error(
      `Usage: node ./scripts/run-e2e-suite.mjs <suite-id>\nKnown suites: ${e2eSuites.map((suite) => suite.id).join(", ")}`,
    );
  }

  const suite = e2eSuiteById(suiteId);
  if (!suite) {
    throw new Error(`Unknown E2E suite '${suiteId}'. Known suites: ${e2eSuites.map((entry) => entry.id).join(", ")}`);
  }

  return suite;
}

async function main() {
  const suite = parseArgs(process.argv.slice(2));
  const invocation = buildPackageManagerInvocation(["exec", "playwright", "test", "--grep", suite.grep]);
  await runCommand(invocation.command, invocation.args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
