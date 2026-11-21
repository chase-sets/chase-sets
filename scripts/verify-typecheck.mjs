import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { repoRoot } from "./lib/repo.mjs";

async function runPackageManager(args, root) {
  const invocation = buildPackageManagerInvocation(args);
  await runCommand(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
  });
}

export async function verifyTypecheck({
  argv = process.argv.slice(2),
  root = repoRoot,
  run = (args) => runPackageManager(args, root),
  stdout = console.log,
} = {}) {
  if (argv.length) {
    const { createTypecheckScope, parseWorkspaceSelectors, printFallbacks, runScopedPrograms } =
      await import("./typecheck-scope.mjs");
    const workspaceNames = parseWorkspaceSelectors(argv);
    const plan = createTypecheckScope({ root }).plan({ workspaceNames });
    if (plan.mode === "scoped") {
      await run(["run", "check:no-any"]);
      return runScopedPrograms(root, plan.programs, (configPath) => run(["exec", "tsc", "-p", configPath, "--noEmit"]));
    }
    printFallbacks(plan.fallbacks, stdout);
  }
  await run(["run", "check:no-any"]);
  await run(["exec", "tsc", "-p", "./tsconfig.json", "--noEmit"]);
  await run(["exec", "tsc", "-p", "./tsconfig.strict.json", "--noEmit"]);
  await run(["run", "test:typecheck"]);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyTypecheck()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error.code ? `[${error.code}] ${error.message}` : error.message);
      process.exitCode = error.exitCode ?? 1;
    });
}
