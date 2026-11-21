import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repo.mjs";
import {
  createTypecheckScope,
  deriveChangedFiles,
  printFallbacks,
  runScopedPrograms,
  TypecheckInputError,
} from "./typecheck-scope.mjs";

const require = createRequire(import.meta.url);

function runTsc(configPath, root) {
  const tscPath = path.resolve(
    path.dirname(require.resolve("typescript/package.json")),
    require("typescript/package.json").bin.tsc,
  );
  const result = spawnSync(process.execPath, [tscPath, "-p", configPath, "--noEmit"], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function runTypecheckChanged({
  argv = process.argv.slice(2),
  env = process.env,
  root = repoRoot,
  execFile,
  runCompiler = (configPath) => runTsc(configPath, root),
  stdout = console.log,
} = {}) {
  if (argv.length) throw new TypecheckInputError("TYPECHECK_CHANGED_USAGE", "Usage: pnpm run typecheck:changed");
  const changedFiles = deriveChangedFiles({ root, env, execFile });
  const plan = createTypecheckScope({ root }).plan({ changedFiles });
  if (plan.mode === "full") {
    printFallbacks(plan.fallbacks, stdout);
    stdout(
      "[TYPECHECK_CHANGED_FULL_REQUIRED] Full Typecheck was not executed; hosted exact-head Typecheck remains authoritative.",
    );
    return 3;
  }
  if (plan.mode === "none") {
    stdout("[TYPECHECK_CHANGED_NO_WORKSPACE] No affected workspace typecheck program.");
    return 0;
  }
  stdout(
    `[TYPECHECK_CHANGED_SCOPED] workspaces=${plan.workspaces.join(",")} programs=${plan.programs.map(({ name }) => name).join(",")}`,
  );
  return runScopedPrograms(root, plan.programs, runCompiler);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTypecheckChanged()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`[${error.code ?? "TYPECHECK_CHANGED_FAILED"}] ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
    });
}
