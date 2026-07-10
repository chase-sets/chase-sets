import path from "node:path";
import { configDefaults } from "vitest/config";
import { listWorkspacePackages, normalizePath, repoRoot } from "./repo.mjs";

// Builds the project list for the root vitest projects-mode run.
// The selection follows a two-pass split:
// - workspaces without a db test profile run their `test` script subset, and
// - db-profile workspaces run their `test:unit` subset (their non-DB tests).
// Workspace package.json scripts stay the single source of truth: the config
// path and `--exclude` patterns are parsed from the script the workspace
// would have run, so the projects run cannot drift from per-workspace runs.

export function selectFastTestTargets(workspaces) {
  const targets = [];

  for (const workspace of workspaces) {
    const scripts = workspace.packageJson.scripts ?? {};
    const testProfile = workspace.packageJson.chaseSets?.testProfile;
    const scriptName = testProfile === "db" ? "test:unit" : "test";
    const script = scripts[scriptName];

    if (typeof script === "string") {
      targets.push({ workspace, scriptName, script });
    }
  }

  return targets;
}

export function parseVitestRunScript(script) {
  const tokens = script.split(/\s+/).filter(Boolean);

  if (tokens[0] !== "vitest" || tokens[1] !== "run") {
    throw new Error(`Expected a "vitest run" script, got: ${script}`);
  }

  let configPath;
  const excludePatterns = [];

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--config") {
      configPath = tokens[index + 1];
      index += 1;
    } else if (token === "--exclude") {
      excludePatterns.push(tokens[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unsupported vitest argument "${token}" in script: ${script}`);
    }
  }

  if (!configPath) {
    throw new Error(`Expected an explicit --config in vitest script: ${script}`);
  }

  return { configPath, excludePatterns };
}

export function buildVitestProjects({ workspaces = listWorkspacePackages(), rootDir = repoRoot } = {}) {
  return selectFastTestTargets(workspaces).map(({ workspace, script }) => {
    const { configPath, excludePatterns } = parseVitestRunScript(script);
    const workspaceConfigPath = normalizePath(path.relative(rootDir, path.join(workspace.dir, configPath)));

    return {
      extends: `./${workspaceConfigPath}`,
      root: normalizePath(workspace.dir),
      test: {
        name: workspace.name.replace(/^@chase-sets\//, ""),
        // Vite concatenates array options when merging the inline project
        // entry with the extended workspace config, so spreading the defaults
        // here keeps them intact for configs that do not set exclude.
        ...(excludePatterns.length > 0 ? { exclude: [...configDefaults.exclude, ...excludePatterns] } : {}),
      },
    };
  });
}
