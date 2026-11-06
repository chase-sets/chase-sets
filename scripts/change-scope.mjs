import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { batchBrowserE2eSuiteIds, e2eSuites, e2eSuiteIdsForChangedFile, orderE2eSuiteIds } from "./e2e-suites.mjs";
import { listWorkspacePackages, normalizePath, repoRoot } from "./lib/repo.mjs";
import { classifyIntegrationRisk } from "./lib/risk-policy-v1.mjs";
import { resolveRequiredProofPaths, unavailableChangeSetSelectionMode } from "./lib/context-proof-sets.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

// Kept local to avoid loading the TypeScript/Vitest-heavy enrollment authority
// from release and static importers. A parity test pins this projection.
export const platformApiEnrollmentSelectors = Object.freeze({
  schema: "db-enrollment-workload/v1",
  w1: Object.freeze({
    census: "deployables/platform-api derivePlatformApiDbTestCensus dbEntries and bootstrapEntries",
    scripts: "deployables/platform-api/package.json test:db:* scripts",
  }),
  w2: Object.freeze([
    "^deployables/platform-api/__tests__/",
    "^deployables/platform-api/src/test-support/",
    "^contracts/[^/]+/test-support\\.ts$",
    "^bounded-contexts/.+/tests/[^/]*test-support\\.ts$",
    "^bounded-contexts/.+/tests/[^/]*fixture[^/]*\\.ts$",
  ]),
  w3: Object.freeze({
    exact: Object.freeze([
      "deployables/platform-api/src/admin-qa-actor-fixtures.ts",
      "deployables/platform-api/src/database-pools.ts",
      "deployables/platform-api/src/representative-commerce-state.ts",
      "bounded-contexts/catalog/features/source-observations/api/provider-integration-profile-store.ts",
      "bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts",
      "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts",
      "bounded-contexts/identity/support/runtime-support/bootstrap-context.ts",
      "infrastructure/bounded-context-runtime/seed-aggregate-state.ts",
      "infrastructure/bounded-context-runtime/seeding.ts",
      "infrastructure/bounded-context-runtime/test-support.ts",
      "infrastructure/platform-runtime/api.ts",
      "infrastructure/platform-runtime/context-pools.ts",
      "infrastructure/platform-runtime/host-runtime-selection.ts",
    ]),
    patterns: Object.freeze([
      Object.freeze({ include: "^contracts/[^/]+-seed/", exclude: "\\.test\\.[^/]+$" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?seed\\.ts$" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?seed-support/" }),
      Object.freeze({ include: "^bounded-contexts/(?:.+/)?api/seeding/" }),
    ]),
    json: "static .json imports of W1-W3 modules at any path, except context.json manifests",
    selections:
      "deployables/platform-api/src/generated/api-context-registry.ts entries projected through infrastructure/platform-runtime/api.ts ApiContextManifest",
  }),
  w4: Object.freeze({
    config: "deployables/platform-api/vitest.config.ts resolved per test:db:* unit with CHASE_SETS_LANE_MODE unset",
    fields: Object.freeze([
      "allowOnly",
      "bail",
      "clearMocks",
      "dangerouslyIgnoreUnhandledErrors",
      "env",
      "environment",
      "environmentOptions",
      "exclude",
      "execArgv",
      "fakeTimers",
      "fileParallelism",
      "globalSetup",
      "globals",
      "hookTimeout",
      "include",
      "includeSource",
      "isolate",
      "maxConcurrency",
      "maxWorkers",
      "minWorkers",
      "mockReset",
      "passWithNoTests",
      "pool",
      "poolOptions",
      "restoreMocks",
      "retry",
      "sequence",
      "setupFiles",
      "teardownTimeout",
      "testNamePattern",
      "testTimeout",
      "unstubEnvs",
      "unstubGlobals",
      "vmMemoryLimit",
    ]),
    environment: Object.freeze({ CI: "true", GITHUB_ACTIONS: "true" }),
    postgres: ".github/workflows/platform-pr.yml db-tests job",
  }),
  w5: Object.freeze({
    lockfile: "pnpm-lock.yaml",
    importer: "deployables/platform-api",
    packages: Object.freeze(["pg", "vitest"]),
  }),
});

const platformApiEnrollmentBindingSections = new Set(["W1 file", "W2 file", "W3 file", "W3 json"]);
const platformApiEnrollmentCache = new Map();
const platformApiConfigCache = new Map();

function platformApiConfigClosure(baseDir) {
  const configPath = path.join(baseDir, "deployables", "platform-api", "vitest.config.ts");
  const signature = (files) =>
    files
      .map((file) => {
        try {
          const stat = statSync(file);
          return `${file}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${file}:missing`;
        }
      })
      .join("|");
  const cached = platformApiConfigCache.get(configPath);
  if (cached && cached.signature === signature(cached.files)) return cached.paths;
  const seen = new Set();
  const queue = [configPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    let source;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const raw = path.resolve(path.dirname(current), match[1]);
      const resolved = [raw, `${raw}.ts`, `${raw}.mjs`, `${raw}.js`, path.join(raw, "index.ts")].find(existsSync);
      queue.push(resolved ?? raw);
    }
  }
  const paths = new Set([...seen].map((filePath) => normalizeFilePath(path.relative(baseDir, filePath))));
  const files = [...seen];
  platformApiConfigCache.set(configPath, { signature: signature(files), files, paths });
  return paths;
}

function platformApiEnrollmentBaseline(baseDir) {
  const fixtureDir = path.join(baseDir, "deployables", "platform-api", "__tests__", "fixtures");
  let names;
  try {
    names = readdirSync(fixtureDir)
      .filter((name) => /^db-enrollment-workload-\d+\.json$/.test(name))
      .sort();
  } catch {
    return { available: false, paths: new Set(), aliasOwners: new Set(), configPaths: new Set() };
  }
  const signature = names
    .map((name) => {
      try {
        const stat = statSync(path.join(fixtureDir, name));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:missing`;
      }
    })
    .join("|");
  const cached = platformApiEnrollmentCache.get(fixtureDir);
  if (cached?.signature === signature) return { ...cached.value, configPaths: platformApiConfigClosure(baseDir) };
  const paths = new Set();
  const aliasTargets = new Set();
  let available = names.length > 0;
  for (const name of names) {
    try {
      const baseline = JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
      if (
        baseline.schema !== platformApiEnrollmentSelectors.schema ||
        !Array.isArray(baseline.bindings) ||
        baseline.bindings.length === 0
      ) {
        available = false;
        continue;
      }
      for (const binding of baseline.bindings) {
        if (
          !Array.isArray(binding) ||
          binding.length !== 3 ||
          typeof binding[0] !== "string" ||
          typeof binding[1] !== "string" ||
          binding[2] === undefined ||
          binding[2] === null
        ) {
          available = false;
          continue;
        }
        if (platformApiEnrollmentBindingSections.has(binding[0]) && typeof binding[1] === "string")
          paths.add(normalizeFilePath(binding[1]));
        if (binding[0] === "W3 selection") {
          if (typeof binding[2].manifest === "string") paths.add(normalizeFilePath(binding[2].manifest));
          else available = false;
        }
        if (binding[0] === "W4 alias" && typeof binding[2] === "string")
          aliasTargets.add(normalizeFilePath(binding[2]));
      }
    } catch {
      available = false;
    }
  }
  const aliasOwners = new Set();
  for (const target of aliasTargets) {
    let current = path.dirname(path.join(baseDir, target));
    while (current.startsWith(baseDir) && current !== baseDir) {
      const packagePath = path.join(current, "package.json");
      if (existsSync(packagePath)) {
        aliasOwners.add(normalizeFilePath(path.relative(baseDir, packagePath)));
        break;
      }
      current = path.dirname(current);
    }
  }
  const value = { available, paths, aliasOwners, configPaths: platformApiConfigClosure(baseDir) };
  platformApiEnrollmentCache.set(fixtureDir, { signature, value });
  return value;
}

function isPlatformApiEnrollmentMember(filePath, baseline) {
  if (filePath === "pnpm-lock.yaml" || filePath === ".github/workflows/platform-pr.yml") return true;
  if (baseline.paths.has(filePath) || baseline.aliasOwners.has(filePath) || baseline.configPaths.has(filePath))
    return true;
  if (platformApiEnrollmentSelectors.w3.exact.includes(filePath)) return true;
  return platformApiEnrollmentSelectors.w3.patterns.some(({ include, exclude }) => {
    return new RegExp(include).test(filePath) && (!exclude || !new RegExp(exclude).test(filePath));
  });
}

function requireRelocatedDbPreparation(baseDir) {
  const owner = "scripts/pr-checks/db-tests.sh";
  try {
    const workflow = parseYaml(readFileSync(path.join(baseDir, ".github/workflows/platform-pr.yml"), "utf8"));
    const job = workflow?.jobs?.["db-tests"];
    const runs = (job?.steps ?? [])
      .map((step) => step.run)
      .filter((run) => typeof run === "string");
    const calls = runs.filter((run) => /\bdb-tests\.sh\s+prepare\b/.test(run));
    if (
      calls.length !== 1 ||
      calls[0].trim() !== `bash ${owner} prepare` ||
      runs.some((run) => /target_max_(?:connections|locks_per_transaction)\s*=/.test(run))
    ) {
      throw new Error("missing, ambiguous, mixed or unbound prepare caller");
    }
    const caller = job.steps.find((step) => step.run === calls[0]);
    const directory = caller["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"];
    const shell = caller.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
    if (caller.if !== undefined || (directory !== undefined && directory !== ".") || (shell !== undefined && shell !== "bash")) {
      throw new Error("unbound prepare caller context");
    }
    const source = readFileSync(path.join(baseDir, owner), "utf8").replaceAll("\r\n", "\n");
    const arms = [...source.matchAll(/^  prepare\)\n([\s\S]*?)^    ;;\s*$/gm)];
    if (arms.length !== 1 || !/^case "\$1" in$/m.test(source)) throw new Error("unbound prepare operation");
    for (const variable of ["target_max_connections", "target_max_locks_per_transaction"]) {
      const assignments = [...arms[0][1].matchAll(new RegExp(`^\\s*${variable}=(.*?)\\s*$`, "gm"))];
      if (assignments.length !== 1 || !/^[1-9][0-9]*$/.test(assignments[0][1])) {
        throw new Error(`missing, duplicate or malformed ${variable}`);
      }
    }
  } catch (error) {
    throw new StaticScopeDerivationError("DB_PREPARATION_OWNER_UNAVAILABLE", `${owner}: ${error.message}`);
  }
}

export class StaticScopeDerivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaticScopeDerivationError";
    this.code = code;
  }
}

function normalizeStaticChangedPath(filePath, repoRoot) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_CHANGED_FILES_INVALID",
      `changed path is outside the repository: ${filePath}`,
    );
  }
  return relativePath.replaceAll("\\", "/");
}

function parseChangedFilesJson(value, repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StaticScopeDerivationError("STATIC_SCOPE_CHANGED_FILES_INVALID", "CHANGED_FILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_CHANGED_FILES_INVALID",
      "CHANGED_FILES_JSON must be an array of non-empty paths",
    );
  }
  return [...new Set(parsed.map((filePath) => normalizeStaticChangedPath(filePath, repoRoot)))];
}

export function parseNameStatusZ(output) {
  const tokens = String(output).split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (/^[RC]\d*$/.test(status)) {
      if (index + 1 >= tokens.length) {
        throw new StaticScopeDerivationError(
          "STATIC_SCOPE_DIFF_INVALID",
          `git diff returned an incomplete ${status} record`,
        );
      }
      files.push(tokens[index++], tokens[index++]);
      continue;
    }
    if (!/^[AMDTUXB]$/.test(status) || index >= tokens.length) {
      throw new StaticScopeDerivationError(
        "STATIC_SCOPE_DIFF_INVALID",
        `git diff returned an invalid name-status record near ${status}`,
      );
    }
    files.push(tokens[index++]);
  }
  return [...new Set(files)];
}

export function deriveStaticChangedFiles({
  repoRoot = rootDir,
  env = process.env,
  execGit = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
} = {}) {
  if (Object.hasOwn(env, "CHANGED_FILES_JSON") && env.CHANGED_FILES_JSON !== undefined) {
    return {
      source: "CHANGED_FILES_JSON",
      files: parseChangedFilesJson(env.CHANGED_FILES_JSON, repoRoot),
    };
  }
  let insideWorkTree;
  try {
    insideWorkTree = execGit(["rev-parse", "--is-inside-work-tree"]).trim();
  } catch {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_NOT_GIT_REPOSITORY",
      "could not confirm that changed-file derivation is running inside a Git worktree",
    );
  }
  if (insideWorkTree !== "true") {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_NOT_GIT_REPOSITORY",
      "changed-file derivation is not running inside a Git worktree",
    );
  }
  let mergeBase;
  try {
    mergeBase = execGit(["merge-base", "refs/remotes/origin/main", "HEAD"]).trim();
  } catch {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_MERGE_BASE_FAILED",
      "could not derive the merge-base for refs/remotes/origin/main and HEAD",
    );
  }
  if (!mergeBase) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_MERGE_BASE_FAILED",
      "the merge-base for refs/remotes/origin/main and HEAD was empty",
    );
  }
  try {
    return {
      source: "git merge-base",
      files: parseNameStatusZ(
        execGit(["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACMRTD", `${mergeBase}...HEAD`, "--"]),
      ),
    };
  } catch (error) {
    if (error instanceof StaticScopeDerivationError) throw error;
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_DIFF_FAILED",
      "could not derive changed paths from the merge-base",
    );
  }
}

const docsOnlyPatterns = [/^docs\//, /^artifacts\//, /^\.codex\//, /^README\.md$/, /^AGENTS\.md$/, /^.*\.md$/];
const platformApiParityDocPatterns = [/^docs\/api\/marketplace\.openapi\.json$/];
// The source-context wake registry is a static aggregate over per-context
// shard modules plus a shared entry builder. Every member of that file
// family must classify exactly like the pre-split single file did, including
// the platform-api contract coverage it feeds; a shard-only match would
// silently stop running those tests on a rollout-state change.
const contextMetadataRoutePatterns = [
  /^bounded-contexts\/[^/]+\/context\.json$/,
  /^infrastructure\/platform-runtime\/source-context-wake-registry(?:-entry)?\.ts$/,
  /^infrastructure\/platform-runtime\/source-context-wake-registry\/[^/]+\.ts$/,
  /^docs\/architecture\/push-first-projection-migration\.md$/,
];

const workflowPatterns = [/^\.github\/workflows\//, /^\.github\/actions\//];
const terraformPatterns = [/^infrastructure\/digitalocean\//];
const planOnlyTerraformPatterns = [/^infrastructure\/digitalocean\/doks\//];
const helmPatterns = [/^infrastructure\/helm\//];
const dockerPatterns = [/^Dockerfile$/, /^\.dockerignore$/, /^deployables\/[^/]+\/Dockerfile$/];
const imageAssetPatterns = [
  /^scripts\/discovery-search-identity-terms-populate\.mjs$/,
  /^scripts\/typescript-resolver-caller-manifests\/discovery-search-identity-terms-populate\.manifest$/,
];
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
const rootTestTypecheckPatterns = [/^tsconfig\.tests\.json$/, /^test-env\.d\.ts$/];
// Root vitest configuration shared by every workspace test run: changing it
// must re-run every workspace's tests, but it is test-only, so it must not
// fan out to builds, docker images, or deploys.
const rootTestConfigPatterns = [/^vitest\.shared\.mjs$/];
const schedulerOwnedArtifacts = new Set([
  "scripts/run-workspaces.mjs",
  "scripts/run-workspaces.test.mjs",
  "scripts/workspace-test-duration-hints-v1.json",
  "scripts/fixtures/workspace-unit-duration-replay-v1.json",
]);
const deploymentScriptPatterns = [
  /^\.github\/workflows\/platform-production-stale-helm-recovery\.yml$/,
  /^scripts\/digitalocean-/,
  /^scripts\/platform-kubernetes-deployment\.mjs$/,
  /^scripts\/platform-smoke/,
  /^scripts\/stripe-money-smoke-test/,
  /^scripts\/apply-digitalocean-database-grant\.mjs$/,
];
const workflowLintScriptPatterns = [
  /^scripts\/platform-ingress-wait\.mjs$/,
  /^scripts\/platform-kubernetes-secret\.mjs$/,
];
// Cluster-preview scoping: a change that only touches these deploy
// surfaces needs the real cluster preview (namespace + Helm release + TLS +
// smoke) to prove out; every other runtime change gets the cheaper CI
// compose boot+smoke instead (see platform-pr.yml's compose-preview-smoke
// job). This is intentionally a superset of `deploymentScriptPatterns`
// above: those patterns also drive the unrelated `deploy` output (the
// "will this promote to staging/production" release-status signal), which
// must not widen just because the cluster-preview surface widens.
const clusterPreviewScriptPatterns = [
  /^scripts\/doks-/,
  /^scripts\/digitalocean-(?!.*\.(?:test|spec)\.[^/]+$)/,
  /^scripts\/platform-kubernetes-deployment\.mjs$/,
  /^scripts\/platform-kubernetes-secret\.mjs$/,
  /^scripts\/platform-ingress-wait\.mjs$/,
  /^scripts\/platform-smoke(?!.*\.(?:test|spec)\.[^/]+$)/,
  /^scripts\/public-web-route-smoke(?:\.test)?\.mjs$/,
  /^scripts\/render-platform-helm-values\.mjs$/,
  /^scripts\/stripe-money-smoke-test/,
  /^scripts\/apply-digitalocean-database-grant\.mjs$/,
];
const clusterPreviewWorkflowPatterns = [/^\.github\/workflows\/platform-pr\.yml$/];
const exposurePosturePatterns = {
  "public-marketplace-launch": [
    /^scripts\/marketplace-(?:launch|production|promotion|public-presence)/,
    /^docs\/runbooks\/marketplace-(?:launch|production-promotion)/,
    /^infrastructure\/digitalocean\/platform\/.*marketplace/i,
  ],
  "live-money-provider": [
    /^bounded-contexts\/(?:checkout|ordering|payments|settlement)\//,
    /^scripts\/(?:stripe|marketplace-stripe|marketplace-checkout-fee)/,
    /^docs\/runbooks\/money-operations\.md$/,
  ],
  "tax-posture": [
    /^bounded-contexts\/ordering\/features\/tax-/,
    /^bounded-contexts\/ordering\/docs\/(?:production-tax-readiness|tax-nexus-tracking)\.md$/,
    /^scripts\/marketplace-tax/,
    /^docs\/runbooks\/tax/i,
  ],
  "postage-provider": [
    /^bounded-contexts\/fulfillment\//,
    /^scripts\/marketplace-fulfillment-postage/,
    /^docs\/runbooks\/postage-operations\.md$/,
  ],
  "transactional-email-provider": [
    /^bounded-contexts\/notifications\//,
    /^scripts\/marketplace-transactional-email/,
    /^docs\/runbooks\/email-operations\.md$/,
  ],
  "ucp-signed-write": [/ucp/i, /^docs\/adr\/0002-adopt-ucp-for-agent-commerce\.md$/],
  "rollout-policy": [
    /^scripts\/release-lock/,
    /^\.github\/workflows\/platform-production-lock-monitor\.yml$/,
    /^docs\/runbooks\/(?:release-process-evolution|doks-platform-operations)\.md$/,
  ],
};

function normalizeFilePath(filePath) {
  return normalizePath(filePath).replace(/^\.\//, "");
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

function isDocsOnlyFile(filePath) {
  if (matchesAny(filePath, platformApiParityDocPatterns)) {
    return false;
  }

  return matchesAny(filePath, docsOnlyPatterns);
}

function isTestOnlyOrDocumentationFile(filePath) {
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
    /(?:^|\/)(?:__tests__|tests|test-support)\//.test(filePath) ||
    /\.(?:md|mdx)$/.test(filePath)
  );
}

function workspaceWorkspaceDependencyNames(dependencyRecord) {
  return Object.entries(dependencyRecord ?? {})
    .filter(([, version]) => typeof version === "string" && version.startsWith("workspace:"))
    .map(([name]) => name);
}

function workspaceDependencyNamesByKind(workspace) {
  const packageJson = workspace.packageJson;
  const runtime = workspaceWorkspaceDependencyNames({
    ...packageJson.dependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies,
  });
  const runtimeNames = new Set(runtime);
  const dev = workspaceWorkspaceDependencyNames(packageJson.devDependencies).filter((name) => !runtimeNames.has(name));

  return { runtime, dev };
}

function buildReverseDependencyGraphs(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const runtime = new Map(workspaces.map((workspace) => [workspace.name, new Set()]));
  const dev = new Map(workspaces.map((workspace) => [workspace.name, new Set()]));

  for (const workspace of workspaces) {
    const dependencyNames = workspaceDependencyNamesByKind(workspace);
    for (const dependencyName of dependencyNames.runtime) {
      if (byName.has(dependencyName)) {
        runtime.get(dependencyName)?.add(workspace.name);
      }
    }
    for (const dependencyName of dependencyNames.dev) {
      if (byName.has(dependencyName)) {
        dev.get(dependencyName)?.add(workspace.name);
      }
    }
  }

  return { runtime, dev };
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

function platformApiWorkspaceName(workspaces) {
  return workspaces.find((workspace) => workspace.root === "deployables" && workspace.dirName === "platform-api")?.name;
}

function platformRuntimeWorkspaceName(workspaces) {
  return workspaces.find((workspace) => workspace.root === "infrastructure" && workspace.dirName === "platform-runtime")
    ?.name;
}

function addTestOnlyWorkspace(workspaceName, filePath, directlyTestOnlyAffectedWorkspaces, testOnlyFilesByWorkspace) {
  if (!workspaceName) {
    return;
  }

  directlyTestOnlyAffectedWorkspaces.add(workspaceName);
  const existing = testOnlyFilesByWorkspace.get(workspaceName) ?? [];
  existing.push(filePath);
  testOnlyFilesByWorkspace.set(workspaceName, existing);
}

export function classifyChanges({
  changedFiles,
  workspaces = listWorkspacePackages({ repoRoot: rootDir }),
  baseDir = rootDir,
}) {
  const normalizedFiles = changedFiles.map(normalizeFilePath).filter(Boolean).sort();
  const directlyRuntimeAffectedWorkspaces = new Set();
  const directlyTestOnlyAffectedWorkspaces = new Set();
  const testOnlyFilesByWorkspace = new Map();
  let workflowChanged = false;
  let terraformChanged = false;
  let previewDeployTerraformChanged = false;
  let helmChanged = false;
  let dockerChanged = false;
  let imageAssetChanged = false;
  let rootRuntimeChanged = false;
  let rootTestTypecheckChanged = false;
  let rootTestConfigChanged = false;
  let schedulerOwnedArtifactChanged = false;
  let deploymentScriptChanged = false;
  let clusterPreviewScriptChanged = false;
  let clusterPreviewWorkflowChanged = false;
  let scriptOrConfigChanged = false;
  const selectedE2eSuiteIds = new Set();
  const exposurePostureCategories = new Set();
  const integrationRisk = classifyIntegrationRisk({ changedFiles: normalizedFiles });
  const integrationRiskReasons = new Set(integrationRisk.reasons);
  let nonDocumentationChanged = false;
  const platformApiWorkspace = platformApiWorkspaceName(workspaces);
  const platformRuntimeWorkspace = platformRuntimeWorkspaceName(workspaces);
  const publicPresenceWorkspace = workspaces.find(
    (workspace) => workspace.root === "bounded-contexts" && workspace.dirName === "public-presence",
  )?.name;
  const platformApiEnrollmentBaselineData = platformApiEnrollmentBaseline(baseDir);
  let platformApiEnrollmentChanged = false;
  const relocatedDbPreparationChanged = normalizedFiles.includes("scripts/pr-checks/db-tests.sh");
  if (relocatedDbPreparationChanged) requireRelocatedDbPreparation(baseDir);

  for (const filePath of normalizedFiles) {
    if (
      !platformApiEnrollmentBaselineData.available ||
      isPlatformApiEnrollmentMember(filePath, platformApiEnrollmentBaselineData) ||
      relocatedDbPreparationChanged
    ) {
      platformApiEnrollmentChanged = true;
    }
    for (const [category, patterns] of Object.entries(exposurePosturePatterns)) {
      if (matchesAny(filePath, patterns)) {
        exposurePostureCategories.add(category);
      }
    }

    for (const suiteId of e2eSuiteIdsForChangedFile(filePath)) {
      selectedE2eSuiteIds.add(suiteId);
    }

    if (matchesAny(filePath, platformApiParityDocPatterns)) {
      nonDocumentationChanged = true;
      addTestOnlyWorkspace(
        platformApiWorkspace,
        filePath,
        directlyTestOnlyAffectedWorkspaces,
        testOnlyFilesByWorkspace,
      );
      continue;
    }

    if (matchesAny(filePath, contextMetadataRoutePatterns)) {
      nonDocumentationChanged = true;
      addTestOnlyWorkspace(
        platformRuntimeWorkspace,
        filePath,
        directlyTestOnlyAffectedWorkspaces,
        testOnlyFilesByWorkspace,
      );
      addTestOnlyWorkspace(
        platformApiWorkspace,
        filePath,
        directlyTestOnlyAffectedWorkspaces,
        testOnlyFilesByWorkspace,
      );
    }

    const workspace = workspaceForFile(filePath, workspaces, baseDir);
    if (workspace) {
      nonDocumentationChanged = true;
      if (isTestOnlyOrDocumentationFile(filePath)) {
        directlyTestOnlyAffectedWorkspaces.add(workspace.name);
        const existing = testOnlyFilesByWorkspace.get(workspace.name) ?? [];
        existing.push(filePath);
        testOnlyFilesByWorkspace.set(workspace.name, existing);
      } else {
        directlyRuntimeAffectedWorkspaces.add(workspace.name);
      }
      continue;
    }

    if (!isDocsOnlyFile(filePath)) {
      nonDocumentationChanged = true;
    }

    workflowChanged ||= matchesAny(filePath, workflowPatterns);
    const terraformFileChanged = matchesAny(filePath, terraformPatterns);
    terraformChanged ||= terraformFileChanged;
    previewDeployTerraformChanged ||= terraformFileChanged && !matchesAny(filePath, planOnlyTerraformPatterns);
    helmChanged ||= matchesAny(filePath, helmPatterns);
    dockerChanged ||= matchesAny(filePath, dockerPatterns);
    imageAssetChanged ||= matchesAny(filePath, imageAssetPatterns);
    rootRuntimeChanged ||= matchesAny(filePath, rootRuntimePatterns);
    rootTestTypecheckChanged ||= matchesAny(filePath, rootTestTypecheckPatterns);
    rootTestConfigChanged ||= matchesAny(filePath, rootTestConfigPatterns);
    schedulerOwnedArtifactChanged ||= schedulerOwnedArtifacts.has(filePath);
    deploymentScriptChanged ||= matchesAny(filePath, deploymentScriptPatterns);
    clusterPreviewScriptChanged ||= matchesAny(filePath, clusterPreviewScriptPatterns);
    clusterPreviewWorkflowChanged ||= matchesAny(filePath, clusterPreviewWorkflowPatterns);
    workflowChanged ||= matchesAny(filePath, workflowLintScriptPatterns);
    scriptOrConfigChanged ||=
      filePath.startsWith("scripts/") || rootRuntimeChanged || rootTestTypecheckChanged || rootTestConfigChanged;
  }

  if (rootTestConfigChanged) {
    for (const workspace of workspaces) {
      directlyTestOnlyAffectedWorkspaces.add(workspace.name);
    }
  }

  if (rootRuntimeChanged) {
    for (const workspace of workspaces) {
      directlyRuntimeAffectedWorkspaces.add(workspace.name);
    }
  }

  const reverseDependencyGraphs = buildReverseDependencyGraphs(workspaces);
  const runtimeAffectedWorkspaceSet = expandDependents(
    directlyRuntimeAffectedWorkspaces,
    reverseDependencyGraphs.runtime,
  );
  // A dev-only workspace edge (devDependencies) means the dependent's tests
  // exercise the changed workspace, but its shipped runtime artifact does not
  // include it. Rerun the direct dependent's tests without fanning out to the
  // dependent's own dependents.
  const devDependencyTestAffectedWorkspaceSet = new Set();
  for (const workspaceName of runtimeAffectedWorkspaceSet) {
    for (const dependent of reverseDependencyGraphs.dev.get(workspaceName) ?? []) {
      if (!runtimeAffectedWorkspaceSet.has(dependent)) {
        devDependencyTestAffectedWorkspaceSet.add(dependent);
      }
    }
  }
  const affectedWorkspaceSet = new Set([
    ...runtimeAffectedWorkspaceSet,
    ...devDependencyTestAffectedWorkspaceSet,
    ...directlyTestOnlyAffectedWorkspaces,
    ...(schedulerOwnedArtifactChanged ? workspaces.map((workspace) => workspace.name) : []),
  ]);
  const runtimeAffectedWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => runtimeAffectedWorkspaceSet.has(workspaceName));

  const runtimeChanged = runtimeAffectedWorkspaces.length > 0 || rootRuntimeChanged;
  const dockerImageRequired = runtimeChanged || dockerChanged || imageAssetChanged;
  const terraformRequired = terraformChanged || deploymentScriptChanged;
  const deployRequired = dockerImageRequired || deploymentScriptChanged || previewDeployTerraformChanged || helmChanged;
  // Cluster-preview scoping: narrower than `deployRequired` above.
  // Deploy surfaces (Helm, preview-relevant Terraform, the Dockerfile,
  // deployment/DOKS/ingress/secret scripts, and the PR preview workflows)
  // still get the real cluster preview; every other runtime-affecting
  // change (dockerImageRequired alone) falls through to the cheaper CI
  // compose boot+smoke job instead of a chase-sets-pr-<n> namespace.
  const clusterPreviewRequired =
    helmChanged ||
    previewDeployTerraformChanged ||
    dockerChanged ||
    clusterPreviewScriptChanged ||
    clusterPreviewWorkflowChanged;
  const composeSmokeRequired = dockerImageRequired && !clusterPreviewRequired;
  const docsOnly = normalizedFiles.length > 0 && !nonDocumentationChanged;
  const localChecksRequired = docsOnly || nonDocumentationChanged || workflowChanged || scriptOrConfigChanged;
  const e2eSuiteIds = orderE2eSuiteIds(selectedE2eSuiteIds);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

  function dbTestScripts(workspace) {
    return Object.entries(workspace?.packageJson.scripts ?? {})
      .filter(([name, command]) => typeof command === "string" && (name === "test:db" || name.startsWith("test:db:")))
      .map(([, command]) => command);
  }

  function workspaceRequiresDbForTestOnlyChange(workspaceName) {
    const workspace = workspaceByName.get(workspaceName);
    const scripts = workspace?.packageJson.scripts ?? {};
    const testDbScripts = dbTestScripts(workspace);
    if (testDbScripts.length === 0) {
      return false;
    }

    const hasNonDbTestScript = typeof scripts.test === "string" || typeof scripts["test:unit"] === "string";
    if (!hasNonDbTestScript) {
      return true;
    }

    const workspaceDir = normalizePath(path.relative(baseDir, workspace.dir));
    return (testOnlyFilesByWorkspace.get(workspaceName) ?? [])
      .map((filePath) => filePath.slice(`${workspaceDir}/`.length))
      .some((relativeFilePath) => testDbScripts.some((script) => script.includes(relativeFilePath)));
  }

  // A scheduler-owned artifact is the process that selects, orders, times, and
  // bounds every DB execution unit, so a change to one must run those units.
  // The fan-out above already unions every workspace into `affectedWorkspaceSet`
  // for exactly this reason; this disjunct reads the same exact-path membership
  // boolean rather than re-testing any path, and stays gated on the same
  // DB-capability rule so it can never require a job with nothing to run.
  const schedulerOwnedChangeRequiresDbTests =
    schedulerOwnedArtifactChanged &&
    [...affectedWorkspaceSet].some((workspaceName) => dbTestScripts(workspaceByName.get(workspaceName)).length > 0);
  const dbTestsRequired =
    normalizedFiles.includes(".github/workflows/platform-pr.yml") ||
    relocatedDbPreparationChanged ||
    [...runtimeAffectedWorkspaceSet, ...devDependencyTestAffectedWorkspaceSet].some((workspaceName) => {
      const workspace = workspaces.find((entry) => entry.name === workspaceName);
      return dbTestScripts(workspace).length > 0;
    }) ||
    [...directlyTestOnlyAffectedWorkspaces].some(workspaceRequiresDbForTestOnlyChange) ||
    schedulerOwnedChangeRequiresDbTests;
  // Public Presence source-authority tests read cited line spans and partition
  // tracked source across the whole repository, so no path vocabulary can name
  // every file they read: any nonempty diff enrolls them test-only. Enrolling
  // after every capability decision above keeps it from adding any, and no
  // foreign path is recorded as a Public Presence test file. An empty list is
  // how both DB-profile runners sweep every DB workspace, so enrollment never
  // narrows that sweep to this one workspace.
  if (publicPresenceWorkspace && normalizedFiles.length > 0 && !(dbTestsRequired && affectedWorkspaceSet.size === 0)) {
    directlyTestOnlyAffectedWorkspaces.add(publicPresenceWorkspace);
    affectedWorkspaceSet.add(publicPresenceWorkspace);
  }
  const affectedWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => affectedWorkspaceSet.has(workspaceName));
  const unitTestWorkspaceSet = new Set(affectedWorkspaces);
  if (platformApiEnrollmentChanged && platformApiWorkspace) unitTestWorkspaceSet.add(platformApiWorkspace);
  const unitTestWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => unitTestWorkspaceSet.has(workspaceName));
  const unitTestsRequired = unitTestWorkspaces.length > 0;
  const result = {
    changedFiles: normalizedFiles,
    affectedWorkspaces,
    runtimeAffectedWorkspaces,
    devDependencyTestAffectedWorkspaces: [...devDependencyTestAffectedWorkspaceSet].sort(),
    directlyAffectedWorkspaces: [
      ...new Set([...directlyRuntimeAffectedWorkspaces, ...directlyTestOnlyAffectedWorkspaces]),
    ].sort(),
    directlyRuntimeAffectedWorkspaces: [...directlyRuntimeAffectedWorkspaces].sort(),
    directlyTestOnlyAffectedWorkspaces: [...directlyTestOnlyAffectedWorkspaces].sort(),
    docsOnly,
    localChecksRequired,
    unitTestsRequired,
    dbTestsRequired,
    e2eSuiteIds,
    e2eTestsRequired: e2eSuiteIds.length > 0,
    integrationRiskRequired: integrationRiskReasons.size > 0,
    integrationRiskReason:
      integrationRiskReasons.size > 0 ? [...integrationRiskReasons].join("; ") : "No integration-risk change detected",
    buildRequired: runtimeAffectedWorkspaces.length > 0 || rootRuntimeChanged,
    dockerImageRequired,
    terraformRequired,
    workflowLintRequired: workflowChanged || helmChanged,
    deployRequired,
    clusterPreviewRequired,
    composeSmokeRequired,
    exposurePostureChanged: exposurePostureCategories.size > 0,
    exposurePostureCategories: [...exposurePostureCategories].sort(),
    requiredProofPaths: resolveRequiredProofPaths({ changedFiles: normalizedFiles, baseDir }),
  };
  Object.defineProperty(result, "unitTestWorkspaces", { value: unitTestWorkspaces, enumerable: false });
  return result;
}

export function listChangedFiles(base, head, options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const cwd = options.cwd ?? repoRoot;
  let mergeBase = options.mergeBase;
  // PR and merge-group workflows check out a synthetic merge commit. Its
  // first parent is the current base tip, so diffing that parent keeps main's
  // intervening commits out of the PR-owned changed set.
  if (!mergeBase && options.firstParent) {
    let parentOutput;
    try {
      parentOutput = exec("git", ["rev-list", "--parents", "-n", "1", head], { cwd, encoding: "utf8" });
    } catch {
      throw new ScopeDerivationError("synthetic-parent-lookup-failed");
    }
    if (typeof parentOutput !== "string" || !parentOutput.trim()) {
      throw new ScopeDerivationError("synthetic-parent-lookup-empty");
    }
    const parents = parentOutput.trim().split(/\s+/);
    mergeBase = parents.length > 2 ? parents[1] : undefined;
  }
  if (!mergeBase) {
    let mergeBaseOutput;
    try {
      mergeBaseOutput = exec("git", ["merge-base", base, head], { cwd, encoding: "utf8" });
    } catch {
      throw new ScopeDerivationError("merge-base-failed");
    }
    if (typeof mergeBaseOutput !== "string" || !mergeBaseOutput.trim()) {
      throw new ScopeDerivationError("merge-base-empty");
    }
    mergeBase = mergeBaseOutput.trim();
  }
  // `--name-only` on its own collapses a detected rename to its destination
  // path only, which drops the source from the changed-file set and silently
  // unselects every gate keyed on that exact path — renaming a scheduler-owned
  // artifact away would stop requiring the DB profile tests it owns.
  // `--no-renames` reports a move conservatively as a deletion plus an
  // addition, so both sides reach the classifier.
  let output;
  try {
    output = exec("git", ["diff", "--no-renames", "--name-only", `${mergeBase}...${head}`], {
      cwd,
      encoding: "utf8",
    });
  } catch {
    throw new ScopeDerivationError("diff-failed");
  }
  if (typeof output !== "string") {
    throw new ScopeDerivationError("diff-invalid");
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

class ScopeDerivationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ScopeDerivationError";
    this.reason = reason;
  }
}

function fullScopeForUnavailableChangeSet(workspaces, reason, baseDir) {
  const workspaceNames = workspaces.map((workspace) => workspace.name).sort();
  return {
    changedFiles: [],
    affectedWorkspaces: workspaceNames,
    runtimeAffectedWorkspaces: workspaceNames,
    devDependencyTestAffectedWorkspaces: workspaceNames,
    directlyAffectedWorkspaces: workspaceNames,
    directlyRuntimeAffectedWorkspaces: workspaceNames,
    directlyTestOnlyAffectedWorkspaces: workspaceNames,
    docsOnly: false,
    localChecksRequired: true,
    unitTestsRequired: true,
    dbTestsRequired: true,
    e2eSuiteIds: orderE2eSuiteIds(e2eSuites.map((suite) => suite.id)),
    e2eTestsRequired: true,
    integrationRiskRequired: true,
    integrationRiskReason: `Scope derivation unavailable; widened to full scope (${reason})`,
    buildRequired: true,
    dockerImageRequired: true,
    terraformRequired: true,
    workflowLintRequired: true,
    deployRequired: true,
    clusterPreviewRequired: true,
    composeSmokeRequired: true,
    exposurePostureChanged: true,
    exposurePostureCategories: Object.keys(exposurePosturePatterns).sort(),
    requiredProofPaths: resolveRequiredProofPaths({
      changedFiles: [],
      selectionMode: unavailableChangeSetSelectionMode,
      baseDir,
    }),
    requiredProofSelectionMode: unavailableChangeSetSelectionMode,
  };
}

export function resolveChangeScope(base, head, options = {}) {
  const workspaces = options.workspaces ?? listWorkspacePackages({ repoRoot: rootDir });
  const baseDir = options.baseDir ?? rootDir;
  let changedFiles;
  try {
    changedFiles = listChangedFiles(base, head, options);
    if (changedFiles.length === 0) {
      throw new ScopeDerivationError("diff-empty");
    }
  } catch (error) {
    const reason = error instanceof ScopeDerivationError ? error.reason : "scope-derivation-failed";
    return {
      scope: fullScopeForUnavailableChangeSet(workspaces, reason, baseDir),
      fallbackReason: reason,
    };
  }
  return {
    scope: classifyChanges({ changedFiles, workspaces, baseDir }),
    fallbackReason: null,
  };
}

function parseArgs(argv) {
  const command = argv[0] ?? "json";
  const options = {};

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
    } else if (arg.startsWith("--head=")) {
      options.head = arg.slice("--head=".length);
    } else if (arg === "--first-parent") {
      options.firstParent = true;
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.base || !options.head) {
    throw new Error(
      "Usage: node ./scripts/change-scope.mjs <json|github-output> --base=<commit> --head=<commit> [--first-parent] [--output=<path>]",
    );
  }

  return { command, options };
}

export function toOutputMap(scope) {
  return {
    changed_files_json: JSON.stringify(scope.changedFiles),
    affected_workspaces: scope.affectedWorkspaces.join(","),
    affected_workspaces_json: JSON.stringify(scope.affectedWorkspaces),
    directly_affected_workspaces_json: JSON.stringify(scope.directlyAffectedWorkspaces),
    docs_only: String(scope.docsOnly),
    local_checks: String(scope.localChecksRequired),
    unit_tests: String(scope.unitTestsRequired),
    unit_test_workspaces: (scope.unitTestWorkspaces ?? scope.affectedWorkspaces ?? []).join(","),
    db_tests: String(scope.dbTestsRequired),
    e2e_tests: String(scope.e2eTestsRequired),
    e2e_suites: scope.e2eSuiteIds.join(","),
    e2e_suites_json: JSON.stringify(scope.e2eSuiteIds),
    e2e_suite_batches_json: JSON.stringify(batchBrowserE2eSuiteIds(scope.e2eSuiteIds)),
    integration_risk_required: String(scope.integrationRiskRequired),
    integration_risk_reason: scope.integrationRiskReason,
    build: String(scope.buildRequired),
    docker_image: String(scope.dockerImageRequired),
    terraform: String(scope.terraformRequired),
    workflow_lint: String(scope.workflowLintRequired),
    deploy: String(scope.deployRequired),
    cluster_preview: String(scope.clusterPreviewRequired),
    compose_smoke: String(scope.composeSmokeRequired),
    exposure_posture_changed: String(scope.exposurePostureChanged),
    exposure_posture_categories: scope.exposurePostureCategories.join(","),
    exposure_posture_categories_json: JSON.stringify(scope.exposurePostureCategories),
    required_proof_paths_json: JSON.stringify(scope.requiredProofPaths),
  };
}

export function toGithubOutputMap(scope) {
  return {
    ...toOutputMap(scope),
    scope_json: JSON.stringify(scope),
  };
}

function writeGithubOutputs(outputPath, scope) {
  const content = Object.entries(toGithubOutputMap(scope))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(outputPath, `${content}\n`, "utf8");
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const { scope, fallbackReason } = resolveChangeScope(options.base, options.head, {
    firstParent: options.firstParent,
    workspaces: listWorkspacePackages({ repoRoot }),
    baseDir: repoRoot,
  });
  if (fallbackReason) {
    console.error(`Change-scope derivation fallback: ${fallbackReason}; widened to full scope.`);
  }

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
    console.log(JSON.stringify(toGithubOutputMap(scope), null, 2));
    return;
  }

  throw new Error(
    "Usage: node ./scripts/change-scope.mjs <json|github-output> --base=<commit> --head=<commit> [--first-parent] [--output=<path>]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
