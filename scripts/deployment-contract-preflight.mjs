import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildPlatformHelmValues,
  extractDigitalOceanPlatformComponents,
  extractDigitalOceanPlatformContextNames,
  readPlatformSources,
} from "./render-platform-helm-values.mjs";

export const DEPLOYMENT_CONTRACT_SCHEMA_VERSION = 1;

const controlPlanes = ["app-platform", "doks"];
const databaseUrlKeyPattern = /^(?:PLATFORM_CONTROL_DATABASE_URL|DATABASE_URL_[A-Z0-9_]+)$/;
const environments = new Set(["staging", "production"]);
const runtimeProfiles = new Set(["landing", "proof", "public"]);

export function renderDeploymentContract(input, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const sources = options.sources ?? readPlatformSources(rootDir);
  const terraformComponents = extractDigitalOceanPlatformComponents(sources);
  const helmValues = buildPlatformHelmValues({ sources });
  const contextNames = extractDigitalOceanPlatformContextNames(sources);
  const environment = String(input.environment ?? "");
  const runtimeProfile = environment === "staging" ? "public" : String(input.runtimeProfile ?? "landing");
  const bootstrapOwner = String(input.bootstrapOwner ?? "");
  const runtimeOwner = String(input.runtimeOwner ?? "");
  const paths = normalizePaths(input.paths);

  const allComponentNames = terraformComponents.map(({ name }) => name);
  const appPlatformComponentNames =
    paths["app-platform"].runtimeMode === "inactive"
      ? []
      : allComponentNames.filter(
          (name) =>
            !(name === "platform-worker" && bootstrapOwner === "doks") &&
            !(name === "marketplace" && environment === "production" && runtimeProfile !== "public"),
        );
  const doksComponentNames = paths.doks.runtimeMode === "inactive" ? [] : allComponentNames;

  const requiredDatabaseUrlKeys = databaseUrlKeys(helmValues.components["platform-bootstrap"]?.env);
  const terraformBootstrap = terraformComponents.find(({ name }) => name === "platform-bootstrap");
  const appPlatformKeys = databaseUrlKeys(terraformBootstrap?.env).filter((key) =>
    activeAppPlatformDatabaseKey(key, runtimeProfile, contextNames),
  );
  const doksKeys = databaseUrlKeys(helmValues.components["platform-bootstrap"]?.env);

  const contract = {
    schemaVersion: DEPLOYMENT_CONTRACT_SCHEMA_VERSION,
    environment,
    runtimeProfile,
    runtimeOwner,
    bootstrapOwner,
    bootstrapOwnerSource: String(input.bootstrapOwnerSource ?? "explicit"),
    rolloutMode: String(input.rolloutMode ?? ""),
    imageIdentity: {
      tagSource: String(input.imageIdentity?.tagSource ?? ""),
      digestSource: String(input.imageIdentity?.digestSource ?? ""),
    },
    controlPlanes: {
      "app-platform": {
        ...paths["app-platform"],
        activeComponents: appPlatformComponentNames,
      },
      doks: {
        ...paths.doks,
        activeComponents: doksComponentNames,
      },
    },
    databaseUrlKeys: {
      required: requiredDatabaseUrlKeys,
      "app-platform": keyStatuses(requiredDatabaseUrlKeys, appPlatformKeys),
      doks: keyStatuses(requiredDatabaseUrlKeys, doksKeys),
    },
  };

  const errors = validateDeploymentContract(contract);
  return { ...contract, pass: errors.length === 0, errors };
}

export function renderWorkflowDeploymentContract(input, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const workflowSource =
    options.workflowSource ?? readFileSync(path.join(rootDir, ".github/workflows/platform-production.yml"), "utf8");
  const variablesSource =
    options.variablesSource ??
    readFileSync(path.join(rootDir, "infrastructure/digitalocean/platform/variables.tf"), "utf8");
  const environment = String(input.environment ?? "");
  if (!environments.has(environment)) {
    return renderDeploymentContract(
      {
        environment,
        runtimeProfile: "landing",
        runtimeOwner: "",
        bootstrapOwner: "",
        paths: {},
        rolloutMode: "",
        imageIdentity: {},
      },
      { rootDir },
    );
  }

  const jobName = environment === "staging" ? "deploy-staging" : "deploy-production";
  const job = workflowJob(workflowSource, jobName);
  const ownerMapping = workflowJobEnv(job, "TF_VAR_platform_bootstrap_owner");
  const terraformDefaultOwner = terraformVariableDefault(variablesSource, "platform_bootstrap_owner");
  const ownerOverride = String(input.bootstrapOwnerOverride ?? "").trim();
  const bootstrapOwner = ownerMapping
    ? ownerOverride || workflowFallback(ownerMapping, "PLATFORM_BOOTSTRAP_OWNER")
    : terraformDefaultOwner;
  const bootstrapOwnerSource = ownerMapping
    ? ownerOverride
      ? "github-environment-variable"
      : "workflow-fallback"
    : "terraform-default";

  const runtimeProfile = resolveRuntimeProfile(environment, job, variablesSource, input);
  const doksActive = job.includes(`- name: Deploy ${environment} Kubernetes release`);
  const appPlatformActive =
    environment === "production" ||
    String(input.appPlatformLane ?? "enabled")
      .trim()
      .toLowerCase() !== "disabled";
  const argoRolloutsEnabled = parseBoolean(input.argoRolloutsEnabled);

  return renderDeploymentContract(
    {
      environment,
      runtimeProfile,
      runtimeOwner: doksActive ? "doks" : appPlatformActive ? "app-platform" : "",
      bootstrapOwner,
      bootstrapOwnerSource,
      paths: {
        doks: {
          runtimeMode: doksActive ? "primary" : "inactive",
          bootstrapMode: doksActive ? "active" : "no-op",
        },
        "app-platform": {
          runtimeMode: appPlatformActive ? (doksActive ? "compatibility" : "primary") : "inactive",
          bootstrapMode: bootstrapOwner === "app-platform" && appPlatformActive ? "active" : "no-op",
        },
      },
      rolloutMode: doksActive ? (argoRolloutsEnabled ? "doks-argo-rollouts" : "doks-helm") : "app-platform",
      imageIdentity: workflowImageIdentity(environment, job),
    },
    { rootDir },
  );
}

export function validateDeploymentContract(contract) {
  const errors = [];
  const environmentLabel = contract.environment || "unknown environment";
  const ownerFallbackConflict =
    contract.bootstrapOwnerSource === "terraform-default" &&
    contract.bootstrapOwner === "app-platform" &&
    contract.controlPlanes.doks.bootstrapMode === "active";

  if (ownerFallbackConflict) {
    errors.push(
      `${capitalize(environmentLabel)} bootstrap ownership fell back to Terraform's 'app-platform' default while the DOKS bootstrap is active. Set TF_VAR_platform_bootstrap_owner explicitly to 'doks' in the ${deploymentJobName(contract.environment)} job so App Platform bootstrap is a no-op.`,
    );
  }
  if (!environments.has(contract.environment)) {
    errors.push("Deployment contract environment must be staging or production.");
  }
  if (!runtimeProfiles.has(contract.runtimeProfile)) {
    errors.push(`${capitalize(environmentLabel)} runtime profile must be landing, proof, or public.`);
  }
  if (!controlPlanes.includes(contract.runtimeOwner)) {
    errors.push(`${capitalize(environmentLabel)} runtime owner must be app-platform or doks.`);
  }
  if (!controlPlanes.includes(contract.bootstrapOwner)) {
    errors.push(`${capitalize(environmentLabel)} bootstrap owner must be app-platform or doks.`);
  }

  const primaryRuntimePaths = controlPlanes.filter(
    (controlPlane) => contract.controlPlanes[controlPlane].runtimeMode === "primary",
  );
  if (primaryRuntimePaths.length !== 1) {
    errors.push(`${capitalize(environmentLabel)} must activate exactly one primary runtime path.`);
  } else if (primaryRuntimePaths[0] !== contract.runtimeOwner) {
    errors.push(
      `${capitalize(environmentLabel)} runtime owner '${contract.runtimeOwner}' does not match primary path '${primaryRuntimePaths[0]}'.`,
    );
  }

  const activeBootstrapPaths = controlPlanes.filter(
    (controlPlane) => contract.controlPlanes[controlPlane].bootstrapMode === "active",
  );
  if (activeBootstrapPaths.length !== 1) {
    errors.push(
      `${capitalize(environmentLabel)} must activate exactly one bootstrap path; active paths: ${activeBootstrapPaths.join(", ") || "none"}.`,
    );
  } else if (activeBootstrapPaths[0] !== contract.bootstrapOwner) {
    errors.push(
      `${capitalize(environmentLabel)} bootstrap owner '${contract.bootstrapOwner}' does not match active path '${activeBootstrapPaths[0]}'.`,
    );
  }

  if (contract.runtimeOwner !== contract.bootstrapOwner) {
    errors.push(
      `${capitalize(environmentLabel)} runtime owner '${contract.runtimeOwner}' and bootstrap owner '${contract.bootstrapOwner}' must match.`,
    );
  }

  if (contract.bootstrapOwner === "doks" && contract.controlPlanes["app-platform"].bootstrapMode !== "no-op") {
    errors.push(`${capitalize(environmentLabel)} App Platform bootstrap must be a no-op while DOKS owns bootstrap.`);
  }

  const ownerKeyStatuses = contract.databaseUrlKeys[contract.bootstrapOwner] ?? [];
  const missingDatabaseUrlKeys = ownerKeyStatuses.filter(({ status }) => status === "missing").map(({ name }) => name);
  if (missingDatabaseUrlKeys.length > 0) {
    const remediation =
      contract.bootstrapOwner === "app-platform"
        ? "Make every required DATABASE_URL key available to the App Platform bootstrap or transfer ownership to DOKS and keep the App Platform bootstrap as a no-op."
        : "Export every required bootstrap database key into the DOKS runtime secret before rollout.";
    errors.push(
      `${capitalize(environmentLabel)} ${contract.bootstrapOwner} bootstrap is missing required database URL keys: ${missingDatabaseUrlKeys.join(", ")}. ${remediation}`,
    );
  }

  const ownerComponents = contract.controlPlanes[contract.runtimeOwner]?.activeComponents ?? [];
  for (const component of ["platform-api", "platform-bootstrap"]) {
    if (!ownerComponents.includes(component)) {
      errors.push(`${capitalize(environmentLabel)} runtime owner '${contract.runtimeOwner}' is missing ${component}.`);
    }
  }
  if (
    contract.bootstrapOwner === "doks" &&
    contract.controlPlanes["app-platform"].activeComponents.includes("platform-worker")
  ) {
    errors.push(`${capitalize(environmentLabel)} App Platform worker must be absent while DOKS owns the runtime.`);
  }

  if (!contract.imageIdentity.tagSource || !contract.imageIdentity.digestSource) {
    errors.push(`${capitalize(environmentLabel)} image tag and digest sources must both be explicit.`);
  }
  if (!new Set(["app-platform", "doks-argo-rollouts", "doks-helm"]).has(contract.rolloutMode)) {
    errors.push(`${capitalize(environmentLabel)} rollout mode is invalid or missing.`);
  }

  return errors;
}

function normalizePaths(paths = {}) {
  return {
    "app-platform": {
      runtimeMode: String(paths["app-platform"]?.runtimeMode ?? "inactive"),
      bootstrapMode: String(paths["app-platform"]?.bootstrapMode ?? "no-op"),
    },
    doks: {
      runtimeMode: String(paths.doks?.runtimeMode ?? "inactive"),
      bootstrapMode: String(paths.doks?.bootstrapMode ?? "no-op"),
    },
  };
}

function databaseUrlKeys(env = []) {
  return env
    .map(({ name }) => name)
    .filter((name) => databaseUrlKeyPattern.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function activeAppPlatformDatabaseKey(key, runtimeProfile, contextNames) {
  if (key === "PLATFORM_CONTROL_DATABASE_URL") {
    return true;
  }
  const activeContexts = runtimeProfile === "landing" ? contextNames.landing : contextNames.platform;
  const activeKeys = new Set(
    activeContexts
      .filter((contextName) => contextName !== "control")
      .map((contextName) => `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`),
  );
  return activeKeys.has(key);
}

function keyStatuses(required, available) {
  const availableKeys = new Set(available);
  return required.map((name) => ({ name, status: availableKeys.has(name) ? "configured" : "missing" }));
}

function resolveRuntimeProfile(environment, job, variablesSource, input) {
  if (environment === "staging") {
    return "public";
  }
  const mapping = workflowJobEnv(job, "TF_VAR_production_runtime_profile");
  if (!mapping) {
    return terraformVariableDefault(variablesSource, "production_runtime_profile");
  }
  const override = String(input.productionRuntimeProfileOverride ?? "").trim();
  if (override) {
    return override;
  }
  return parseBoolean(input.productionMarketplacePublicEnabled) ? "public" : "landing";
}

function workflowImageIdentity(environment, job) {
  const tagMapping = workflowJobEnv(job, "TF_VAR_platform_image_tag") ?? "";
  const digestMapping = workflowJobEnv(job, "TF_VAR_platform_image_digest") ?? "";
  const tagSource = tagMapping.includes("needs.resolve-release.outputs.release_commit") ? "release-commit" : "";
  const doksImagePinned = job.includes(
    "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}",
  );
  let digestSource = "";
  if (environment === "staging") {
    if (
      doksImagePinned &&
      job.includes("TF_VAR_platform_image_digest=${ACTIVE_RELEASE_IMAGE_DIGEST}") &&
      job.includes("ACTIVE_RELEASE_IMAGE_DIGEST: ${{ steps.activate_release.outputs.active_image_digest }}")
    ) {
      digestSource = "build-release-image-digest";
    }
  } else if (doksImagePinned && digestMapping.includes("needs.deploy-staging.outputs.platform_image_digest")) {
    digestSource = "staging-verified-image-digest";
  }
  return { tagSource, digestSource };
}

function workflowJob(source, jobName) {
  const marker = `  ${jobName}:`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow job '${jobName}' is missing.`);
  }
  const remaining = source.slice(start + marker.length);
  const nextOffset = remaining.search(/\n  [a-zA-Z0-9_-]+:\r?\n/);
  return nextOffset === -1 ? source.slice(start) : source.slice(start, start + marker.length + nextOffset);
}

function workflowJobEnv(job, name) {
  const envStart = job.indexOf("\n    env:\n");
  const stepsStart = job.indexOf("\n    steps:", envStart + 1);
  if (envStart === -1 || stepsStart === -1) {
    return null;
  }
  const envBlock = job.slice(envStart, stepsStart);
  const match = new RegExp(`^      ${name}:\\s*(.+)$`, "m").exec(envBlock);
  return match?.[1]?.trim() ?? null;
}

function workflowFallback(mapping, variableName) {
  if (!mapping.includes(`vars.${variableName}`)) {
    return "";
  }
  return /\|\|\s*'([^']+)'/.exec(mapping)?.[1] ?? "";
}

function terraformVariableDefault(source, variableName) {
  const marker = `variable "${variableName}"`;
  const start = source.indexOf(marker);
  if (start === -1) {
    return "";
  }
  const blockStart = source.indexOf("{", start);
  const blockEnd = matchingBrace(source, blockStart);
  const block = source.slice(blockStart + 1, blockEnd);
  return /^\s*default\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? "";
}

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("Unclosed Terraform variable block.");
}

function deploymentJobName(environment) {
  return environment === "staging" ? "deploy-staging" : "deploy-production";
}

function parseBoolean(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendFailureSummary(filePath, contract, artifactPath) {
  if (!filePath || contract.pass) {
    return;
  }
  const lines = [
    `## Deployment contract preflight failed: ${contract.environment}`,
    "",
    ...contract.errors.map((error) => `- ${error}`),
    "",
    `Redacted contract artifact: \`${artifactPath}\``,
    "",
  ];
  writeFileSync(filePath, lines.join("\n"), { flag: "a" });
}

async function main(argv) {
  const fixturePath = readOption(argv, "--fixture");
  const rootDir = readOption(argv, "--root-dir") ?? process.cwd();
  const outPath = readOption(argv, "--out") ?? "artifacts/deployment-contract-preflight.json";
  const githubSummary = readOption(argv, "--github-summary");
  const input = fixturePath
    ? JSON.parse(readFileSync(fixturePath, "utf8"))
    : {
        environment: readOption(argv, "--environment"),
        bootstrapOwnerOverride: readOption(argv, "--bootstrap-owner-override"),
        productionRuntimeProfileOverride: readOption(argv, "--production-runtime-profile-override"),
        productionMarketplacePublicEnabled: readOption(argv, "--production-marketplace-public-enabled"),
        argoRolloutsEnabled: readOption(argv, "--argo-rollouts-enabled"),
        appPlatformLane: readOption(argv, "--app-platform-lane"),
      };
  const contract = fixturePath
    ? renderDeploymentContract(input, { rootDir })
    : renderWorkflowDeploymentContract(input, { rootDir });
  writeJson(outPath, contract);
  appendFailureSummary(githubSummary, contract, outPath);
  console.log(
    JSON.stringify({
      environment: contract.environment,
      runtimeOwner: contract.runtimeOwner,
      bootstrapOwner: contract.bootstrapOwner,
      rolloutMode: contract.rolloutMode,
      pass: contract.pass,
      errors: contract.errors,
    }),
  );
  if (!contract.pass) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
