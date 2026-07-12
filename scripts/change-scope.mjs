import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  batchE2eSuiteIds,
  e2eSuiteIdsForChangedFile,
  isDesignSystemNavigationFile,
  orderE2eSuiteIds,
} from "./e2e-suites.mjs";
import { listWorkspacePackages, normalizePath, repoRoot } from "./lib/repo.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

const docsOnlyPatterns = [/^docs\//, /^artifacts\//, /^\.codex\//, /^README\.md$/, /^AGENTS\.md$/, /^.*\.md$/];
const platformApiParityDocPatterns = [/^docs\/api\/marketplace\.openapi\.json$/];
const contextMetadataRoutePatterns = [
  /^bounded-contexts\/[^/]+\/context\.json$/,
  /^infrastructure\/platform-runtime\/source-context-wake-registry\.ts$/,
  /^docs\/architecture\/push-first-projection-migration\.md$/,
];

const integrationRiskPatterns = [
  {
    reason: "Bounded-context metadata, including event subscriptions, changed",
    patterns: [/^bounded-contexts\/[^/]+\/context\.json$/],
  },
  {
    reason: "Cross-context subscription or runtime composition changed",
    patterns: [
      /^infrastructure\/bounded-context-runtime\//,
      /^infrastructure\/platform-runtime\//,
      /^deployables\/(?:platform-api|platform-worker)\/src\/generated\/.*context-registry\.ts$/,
      /^deployables\/(?:admin-web|marketplace|public-web)\/app\/generated\/web-context-registry\.ts$/,
    ],
  },
  {
    reason: "Shared application shell or router changed",
    patterns: [
      /^deployables\/admin-web\/app\/(?:admin-root-shell|host|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/admin-web\/app\/routes\/[^/]+-layout\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/(?:root|routes)\.[cm]?[tj]sx?$/,
      /^deployables\/marketplace\/app\/routes\/layout\.[cm]?[tj]sx?$/,
    ],
  },
  {
    reason: "Design-system navigation changed",
    matches: isDesignSystemNavigationFile,
  },
];

const workflowPatterns = [/^\.github\/workflows\//, /^\.github\/actions\//];
const terraformPatterns = [/^infrastructure\/digitalocean\//];
const planOnlyTerraformPatterns = [/^infrastructure\/digitalocean\/doks\//];
const helmPatterns = [/^infrastructure\/helm\//];
const dockerPatterns = [/^Dockerfile$/, /^\.dockerignore$/, /^deployables\/[^/]+\/Dockerfile$/];
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
const rootTestConfigPatterns = [/^vitest\.projects\.config\.mjs$/, /^vitest\.shared\.mjs$/];
const deploymentScriptPatterns = [
  /^scripts\/digitalocean-/,
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
  /^scripts\/platform-kubernetes-deployment\.mjs$/,
  /^scripts\/platform-kubernetes-secret\.mjs$/,
  /^scripts\/platform-ingress-wait\.mjs$/,
  /^scripts\/render-platform-helm-values\.mjs$/,
];
const clusterPreviewWorkflowPatterns = [/^\.github\/workflows\/platform-.*\.yml$/];
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
  "ucp-signed-write": [/ucp/i, /ap2/i, /^docs\/adr\/0002-adopt-ucp-for-agent-commerce\.md$/],
  "rollout-policy": [/^scripts\/release-lock/, /^docs\/runbooks\/release-process-evolution\.md$/],
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
  let rootRuntimeChanged = false;
  let rootTestTypecheckChanged = false;
  let rootTestConfigChanged = false;
  let deploymentScriptChanged = false;
  let clusterPreviewScriptChanged = false;
  let clusterPreviewWorkflowChanged = false;
  let scriptOrConfigChanged = false;
  const selectedE2eSuiteIds = new Set();
  const exposurePostureCategories = new Set();
  const integrationRiskReasons = new Set();
  let nonDocumentationChanged = false;
  const platformApiWorkspace = platformApiWorkspaceName(workspaces);
  const platformRuntimeWorkspace = platformRuntimeWorkspaceName(workspaces);

  for (const filePath of normalizedFiles) {
    for (const integrationRiskPattern of integrationRiskPatterns) {
      if (integrationRiskPattern.matches?.(filePath) || matchesAny(filePath, integrationRiskPattern.patterns ?? [])) {
        integrationRiskReasons.add(integrationRiskPattern.reason);
      }
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
    rootRuntimeChanged ||= matchesAny(filePath, rootRuntimePatterns);
    rootTestTypecheckChanged ||= matchesAny(filePath, rootTestTypecheckPatterns);
    rootTestConfigChanged ||= matchesAny(filePath, rootTestConfigPatterns);
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
  ]);
  const affectedWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => affectedWorkspaceSet.has(workspaceName));
  const runtimeAffectedWorkspaces = workspaces
    .map((workspace) => workspace.name)
    .filter((workspaceName) => runtimeAffectedWorkspaceSet.has(workspaceName));

  const runtimeChanged = runtimeAffectedWorkspaces.length > 0 || rootRuntimeChanged;
  const dockerImageRequired = runtimeChanged || dockerChanged;
  const terraformRequired = terraformChanged || deploymentScriptChanged;
  const deployRequired = dockerImageRequired || deploymentScriptChanged || previewDeployTerraformChanged;
  // Cluster-preview scoping: narrower than `deployRequired` above.
  // Deploy surfaces (Helm, preview-relevant Terraform, the Dockerfile,
  // deployment/DOKS/ingress/secret scripts, and platform-*.yml workflows)
  // still get the real cluster preview; every other runtime-affecting
  // change (dockerImageRequired alone) falls through to the cheaper CI
  // compose boot+smoke job instead of a chase-sets-pr-<n> namespace.
  const clusterPreviewRequired =
    helmChanged ||
    previewDeployTerraformChanged ||
    dockerChanged ||
    deploymentScriptChanged ||
    clusterPreviewScriptChanged ||
    clusterPreviewWorkflowChanged;
  const composeSmokeRequired = dockerImageRequired && !clusterPreviewRequired;
  const docsOnly = normalizedFiles.length > 0 && !nonDocumentationChanged;
  const localChecksRequired = docsOnly || nonDocumentationChanged || workflowChanged || scriptOrConfigChanged;
  const e2eSuiteIds = orderE2eSuiteIds(selectedE2eSuiteIds);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

  function workspaceRequiresDbForTestOnlyChange(workspaceName) {
    const workspace = workspaceByName.get(workspaceName);
    const scripts = workspace?.packageJson.scripts ?? {};
    const testDbScript = scripts["test:db"];
    if (typeof testDbScript !== "string") {
      return false;
    }

    const hasNonDbTestScript = typeof scripts.test === "string" || typeof scripts["test:unit"] === "string";
    if (!hasNonDbTestScript) {
      return true;
    }

    const workspaceDir = normalizePath(path.relative(baseDir, workspace.dir));
    return (testOnlyFilesByWorkspace.get(workspaceName) ?? [])
      .map((filePath) => filePath.slice(`${workspaceDir}/`.length))
      .some((relativeFilePath) => testDbScript.includes(relativeFilePath));
  }

  const unitTestsRequired = affectedWorkspaces.length > 0;
  const dbTestsRequired =
    [...runtimeAffectedWorkspaceSet, ...devDependencyTestAffectedWorkspaceSet].some((workspaceName) => {
      const workspace = workspaces.find((entry) => entry.name === workspaceName);
      return typeof workspace?.packageJson.scripts?.["test:db"] === "string";
    }) || [...directlyTestOnlyAffectedWorkspaces].some(workspaceRequiresDbForTestOnlyChange);
  return {
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
  };
}

export function listChangedFiles(base, head, options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const cwd = options.cwd ?? repoRoot;
  const mergeBase =
    options.mergeBase ??
    exec("git", ["merge-base", base, head], {
      cwd,
      encoding: "utf8",
    }).trim();
  const output = exec("git", ["diff", "--name-only", `${mergeBase}...${head}`], {
    cwd,
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

export function toOutputMap(scope) {
  return {
    changed_files_json: JSON.stringify(scope.changedFiles),
    affected_workspaces: scope.affectedWorkspaces.join(","),
    affected_workspaces_json: JSON.stringify(scope.affectedWorkspaces),
    directly_affected_workspaces_json: JSON.stringify(scope.directlyAffectedWorkspaces),
    docs_only: String(scope.docsOnly),
    local_checks: String(scope.localChecksRequired),
    unit_tests: String(scope.unitTestsRequired),
    db_tests: String(scope.dbTestsRequired),
    e2e_tests: String(scope.e2eTestsRequired),
    e2e_suites: scope.e2eSuiteIds.join(","),
    e2e_suites_json: JSON.stringify(scope.e2eSuiteIds),
    e2e_suite_batches_json: JSON.stringify(batchE2eSuiteIds(scope.e2eSuiteIds)),
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
