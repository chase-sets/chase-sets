import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { e2eSuiteIdsForChangedFile, orderE2eSuiteIds } from "./e2e-suites.mjs";
import { listWorkspacePackages, normalizePath, repoRoot } from "./lib/repo.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

const docsOnlyPatterns = [/^docs\//, /^artifacts\//, /^\.codex\//, /^README\.md$/, /^AGENTS\.md$/, /^.*\.md$/];

const workflowPatterns = [/^\.github\/workflows\//, /^\.github\/actions\//];
const terraformPatterns = [/^infrastructure\/digitalocean\//];
const dockerPatterns = [/^Dockerfile$/, /^\.dockerignore$/];
const rootRuntimePatterns = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^tsconfig\.json$/,
  /^tsconfig\.base\.json$/,
  /^tailwind\.config\.ts$/,
  /^playwright\.config\.ts$/,
];
const deploymentScriptPatterns = [
  /^scripts\/digitalocean-/,
  /^scripts\/platform-smoke/,
  /^scripts\/stripe-money-smoke-test/,
  /^scripts\/apply-digitalocean-database-grant\.mjs$/,
];

function normalizeFilePath(filePath) {
  return normalizePath(filePath).replace(/^\.\//, "");
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

function isDocsOnlyFile(filePath) {
  return matchesAny(filePath, docsOnlyPatterns);
}

function workspaceDependencyNames(workspace) {
  const packageJson = workspace.packageJson;
  const dependencyEntries = Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies,
  });

  return dependencyEntries
    .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
    .map(([name]) => name);
}

function buildReverseDependencyGraph(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const reverse = new Map(workspaces.map((workspace) => [workspace.name, new Set()]));

  for (const workspace of workspaces) {
    for (const dependencyName of workspaceDependencyNames(workspace)) {
      if (byName.has(dependencyName)) {
        reverse.get(dependencyName)?.add(workspace.name);
      }
    }
  }

  return reverse;
}

function expandDependents(workspaceNames, reverseDependencyGraph) {
  const affected = new Set(workspaceNames);
  const queue = [...workspaceNames];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of reverseDependencyGraph.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return affected;
}

function workspaceForFile(filePath, workspaces, baseDir) {
  const normalized = normalizeFilePath(filePath);
  return workspaces.find((workspace) => {
    const workspaceDir = normalizePath(path.relative(baseDir, workspace.dir));
    return normalized === workspaceDir || normalized.startsWith(`${workspaceDir}/`);
  });
}

export function classifyChanges({
  changedFiles,
  workspaces = listWorkspacePackages({ repoRoot: rootDir }),
  baseDir = rootDir,
}) {
  const normalizedFiles = changedFiles.map(normalizeFilePath).filter(Boolean).sort();
  const directlyAffectedWorkspaces = new Set();
  let workflowChanged = false;
  let terraformChanged = false;
  let dockerChanged = false;
  let rootRuntimeChanged = false;
  let deploymentScriptChanged = false;
  let scriptOrConfigChanged = false;
  const selectedE2eSuiteIds = new Set();
  let nonDocumentationChanged = false;

  for (const filePath of normalizedFiles) {
    for (const suiteId of e2eSuiteIdsForChangedFile(filePath)) {
      selectedE2eSuiteIds.add(suiteId);
    }

    const workspace = workspaceForFile(filePath, workspaces, baseDir);
    if (workspace) {
      directlyAffectedWorkspaces.add(workspace.name);
      nonDocumentationChanged = true;
      continue;
    }

    if (!isDocsOnlyFile(filePath)) {
      nonDocumentationChanged = true;
    }

    workflowChanged ||= matchesAny(filePath, workflowPatterns);
    terraformChanged ||= matchesAny(filePath, terraformPatterns);
    dockerChanged ||= matchesAny(filePath, dockerPatterns);
    rootRuntimeChanged ||= matchesAny(filePath, rootRuntimePatterns);
    deploymentScriptChanged ||= matchesAny(filePath, deploymentScriptPatterns);
    scriptOrConfigChanged ||= filePath.startsWith("scripts/") || rootRuntimeChanged;
  }

  if (rootRuntimeChanged) {
    for (const workspace of workspaces) {
      directlyAffectedWorkspaces.add(workspace.name);
    }
  }

  const reverseDependencyGraph = buildReverseDependencyGraph(workspaces);
  const affectedWorkspaceSet = expandDependents(directlyAffectedWorkspaces, reverseDependencyGraph);
  const affectedWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => affectedWorkspaceSet.has(workspaceName));

  const runtimeChanged = affectedWorkspaces.length > 0 || rootRuntimeChanged;
  const dockerImageRequired = runtimeChanged || dockerChanged;
  const terraformRequired = terraformChanged || deploymentScriptChanged;
  const deployRequired = dockerImageRequired || terraformRequired;
  const localChecksRequired = nonDocumentationChanged || workflowChanged || scriptOrConfigChanged;
  const e2eSuiteIds = orderE2eSuiteIds(selectedE2eSuiteIds);

  return {
    changedFiles: normalizedFiles,
    affectedWorkspaces,
    directlyAffectedWorkspaces: [...directlyAffectedWorkspaces].sort(),
    docsOnly: normalizedFiles.length > 0 && !nonDocumentationChanged,
    localChecksRequired,
    typecheckRequired: affectedWorkspaces.length > 0 || rootRuntimeChanged,
    unitTestsRequired: affectedWorkspaces.length > 0,
    dbTestsRequired: affectedWorkspaces.some((workspaceName) => {
      const workspace = workspaces.find((entry) => entry.name === workspaceName);
      return typeof workspace?.packageJson.scripts?.["test:db"] === "string";
    }),
    e2eSuiteIds,
    e2eTestsRequired: e2eSuiteIds.length > 0,
    buildRequired: affectedWorkspaces.length > 0 || rootRuntimeChanged,
    dockerImageRequired,
    terraformRequired,
    workflowLintRequired: workflowChanged,
    deployRequired,
  };
}

function listChangedFiles(base, head, options = {}) {
  const output = (options.execFileSync ?? execFileSync)("git", ["diff", "--name-only", `${base}..${head}`], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const command = argv[0] ?? "json";
  const options = {};

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
    } else if (arg.startsWith("--head=")) {
      options.head = arg.slice("--head=".length);
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.base || !options.head) {
    throw new Error(
      "Usage: node ./scripts/change-scope.mjs <json|github-output> --base=<commit> --head=<commit> [--output=<path>]",
    );
  }

  return { command, options };
}

function toOutputMap(scope) {
  return {
    changed_files_json: JSON.stringify(scope.changedFiles),
    affected_workspaces: scope.affectedWorkspaces.join(","),
    affected_workspaces_json: JSON.stringify(scope.affectedWorkspaces),
    directly_affected_workspaces_json: JSON.stringify(scope.directlyAffectedWorkspaces),
    docs_only: String(scope.docsOnly),
    local_checks: String(scope.localChecksRequired),
    typecheck: String(scope.typecheckRequired),
    unit_tests: String(scope.unitTestsRequired),
    db_tests: String(scope.dbTestsRequired),
    e2e_tests: String(scope.e2eTestsRequired),
    e2e_suites: scope.e2eSuiteIds.join(","),
    e2e_suites_json: JSON.stringify(scope.e2eSuiteIds),
    build: String(scope.buildRequired),
    docker_image: String(scope.dockerImageRequired),
    terraform: String(scope.terraformRequired),
    workflow_lint: String(scope.workflowLintRequired),
    deploy: String(scope.deployRequired),
  };
}

function writeGithubOutputs(outputPath, scope) {
  const content = Object.entries(toOutputMap(scope))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(outputPath, `${content}\n`, "utf8");
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const scope = classifyChanges({
    changedFiles: listChangedFiles(options.base, options.head),
    workspaces: listWorkspacePackages({ repoRoot }),
    baseDir: repoRoot,
  });

  if (command === "json") {
    console.log(JSON.stringify(scope, null, 2));
    return;
  }

  if (command === "github-output") {
    const outputPath = options.output ?? process.env.GITHUB_OUTPUT;
    if (!outputPath) {
      throw new Error("GITHUB_OUTPUT is not set. Pass --output=<path> when running outside GitHub Actions.");
    }
    writeGithubOutputs(outputPath, scope);
    console.log(JSON.stringify(toOutputMap(scope), null, 2));
    return;
  }

  throw new Error(
    "Usage: node ./scripts/change-scope.mjs <json|github-output> --base=<commit> --head=<commit> [--output=<path>]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
