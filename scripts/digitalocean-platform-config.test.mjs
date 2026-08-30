import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_WEB_API_DEPENDENCIES } from "./admin-shell-smoke-matrix.mjs";
import { classifyChanges } from "./change-scope.mjs";
import { listContextManifests } from "./lib/repo.mjs";
import {
  assertNoDestructiveChanges,
  destructiveChangeApprovalFromText,
  terraformPlanSummary,
} from "./terraform-plan-inspection.mjs";

const platformMain = readFileSync(resolve("infrastructure/digitalocean/platform/main.tf"), "utf8");
const platformVersions = readFileSync(resolve("infrastructure/digitalocean/platform/versions.tf"), "utf8");
const platformLocals = readFileSync(resolve("infrastructure/digitalocean/platform/locals.tf"), "utf8");
const platformOutputs = readFileSync(resolve("infrastructure/digitalocean/platform/outputs.tf"), "utf8");
const platformVariables = readFileSync(resolve("infrastructure/digitalocean/platform/variables.tf"), "utf8");
const platformProjects = readFileSync(resolve("infrastructure/digitalocean/platform/projects.tf"), "utf8");
const doksMain = readFileSync(resolve("infrastructure/digitalocean/doks/main.tf"), "utf8");
const observabilityMain = readFileSync(resolve("infrastructure/digitalocean/observability/main.tf"), "utf8");
const observabilityLocals = readFileSync(resolve("infrastructure/digitalocean/observability/locals.tf"), "utf8");
const observabilityOutputs = readFileSync(resolve("infrastructure/digitalocean/observability/outputs.tf"), "utf8");
const observabilityVariables = readFileSync(resolve("infrastructure/digitalocean/observability/variables.tf"), "utf8");
const observabilityCaddyfile = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/Caddyfile.tftpl"),
  "utf8",
);
const observabilityCloudInit = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/cloud-init.yml.tftpl"),
  "utf8",
);
const observabilityDockerCompose = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/docker-compose.yml.tftpl"),
  "utf8",
);
const observabilityCollectorTemplate = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/collector-config.yml.tftpl"),
  "utf8",
);
const observabilityPrometheusTemplate = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/prometheus.yml.tftpl"),
  "utf8",
);
const observabilityContactPointsTemplate = readFileSync(
  resolve("infrastructure/digitalocean/observability/templates/contact-points.yml.tftpl"),
  "utf8",
);
const catalogAssetsMain = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/main.tf"), "utf8");
const catalogAssetsLocals = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/locals.tf"), "utf8");
const objectStorageMain = readFileSync(resolve("infrastructure/object-storage/index.ts"), "utf8");
const stateBootstrapMain = readFileSync(resolve("infrastructure/digitalocean/state-bootstrap/main.tf"), "utf8");
const environmentDnsMain = readFileSync(resolve("infrastructure/digitalocean/environment-dns/main.tf"), "utf8");
const environmentDnsLocals = readFileSync(resolve("infrastructure/digitalocean/environment-dns/locals.tf"), "utf8");
const environmentDnsOutputs = readFileSync(resolve("infrastructure/digitalocean/environment-dns/outputs.tf"), "utf8");
const environmentDnsVariables = readFileSync(
  resolve("infrastructure/digitalocean/environment-dns/variables.tf"),
  "utf8",
);
const environmentDnsProjects = readFileSync(resolve("infrastructure/digitalocean/environment-dns/projects.tf"), "utf8");
const platformProductionWorkflow = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");
const platformProductionStaleHelmRecoveryWorkflow = readFileSync(
  resolve(".github/workflows/platform-production-stale-helm-recovery.yml"),
  "utf8",
);
const exportManagedPostgresAuthorityAction = readFileSync(
  resolve(".github/actions/export-managed-postgres-authority/action.yml"),
  "utf8",
);
const platformReleaseCandidateWorkflow = readFileSync(
  resolve(".github/workflows/platform-release-candidate.yml"),
  "utf8",
);
const platformStagingAdvisoryEvidenceWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-advisory-evidence.yml"),
  "utf8",
);
const platformPrWorkflow = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");
const playwrightConfig = readFileSync(resolve("playwright.config.ts"), "utf8");
const platformCoverageWorkflow = readFileSync(resolve(".github/workflows/platform-coverage.yml"), "utf8");
const platformDoksFoundationWorkflow = readFileSync(resolve(".github/workflows/platform-doks-foundation.yml"), "utf8");
const platformObservabilityStateMigrationWorkflow = readFileSync(
  resolve(".github/workflows/platform-observability-state-migration.yml"),
  "utf8",
);
const platformKubernetesDeploymentScript = readFileSync(resolve("scripts/platform-kubernetes-deployment.mjs"), "utf8");
const renderPlatformHelmValuesScript = readFileSync(resolve("scripts/render-platform-helm-values.mjs"), "utf8");
const platformRuntimeValues = readFileSync(resolve("infrastructure/helm/platform/runtime-values.json"), "utf8");
const previewPostgresTemplate = readFileSync(
  resolve("infrastructure/helm/platform/templates/preview-postgres.yaml"),
  "utf8",
);
const platformPreviewCleanupWorkflow = readFileSync(resolve(".github/workflows/platform-preview-cleanup.yml"), "utf8");
const platformStagingResetWorkflow = readFileSync(resolve(".github/workflows/platform-staging-reset.yml"), "utf8");
const platformDigitalOceanDriftDigestWorkflow = readFileSync(
  resolve(".github/workflows/platform-digitalocean-drift-digest.yml"),
  "utf8",
);
const platformCatalogAssetsStateRepairWorkflow = readFileSync(
  resolve(".github/workflows/platform-catalog-assets-state-repair.yml"),
  "utf8",
);
const platformDigitalOceanTokenRotationReminderWorkflow = readFileSync(
  resolve(".github/workflows/platform-digitalocean-token-rotation-reminder.yml"),
  "utf8",
);
const platformEmergencyRecoveryWorkflow = readFileSync(
  resolve(".github/workflows/platform-emergency-recovery.yml"),
  "utf8",
);
const platformProductionRestorePointCleanupWorkflow = readFileSync(
  resolve(".github/workflows/platform-production-restore-point-cleanup.yml"),
  "utf8",
);
const platformRegistryCleanupWorkflow = readFileSync(
  resolve(".github/workflows/platform-registry-cleanup.yml"),
  "utf8",
);
const platformRollbackReadinessWorkflow = readFileSync(
  resolve(".github/workflows/platform-rollback-readiness.yml"),
  "utf8",
);
const platformTerraformStateSnapshotWorkflow = readFileSync(
  resolve(".github/workflows/platform-terraform-state-snapshot.yml"),
  "utf8",
);
const platformDatabaseRestoreDrillWorkflow = readFileSync(
  resolve(".github/workflows/platform-database-restore-drill.yml"),
  "utf8",
);
const platformPostgresGrowthEvidenceWorkflow = readFileSync(
  resolve(".github/workflows/platform-postgres-growth-evidence.yml"),
  "utf8",
);
const platformStagingRollbackDrillWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-rollback-drill.yml"),
  "utf8",
);
const platformStagingHelmRecoveryWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-helm-recovery.yml"),
  "utf8",
);
const platformStagingBootstrapHookDrillWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-bootstrap-hook-drill.yml"),
  "utf8",
);
const platformHelmStagingValues = readFileSync(resolve("infrastructure/helm/platform/values.staging.yaml"), "utf8");
const digitaloceanPlatformRunbook = readFileSync(resolve("docs/runbooks/digitalocean-platform-deployment.md"), "utf8");
const doksPlatformOperationsRunbook = readFileSync(resolve("docs/runbooks/doks-platform-operations.md"), "utf8");
const productionPgBouncerSessionSafety = readFileSync(
  resolve("docs/architecture/production-pgbouncer-session-safety.md"),
  "utf8",
);
const deployableProfileDatabaseCompanion = readFileSync(
  resolve("docs/architecture/deployable-profile-database-companion.md"),
  "utf8",
);
const marketplaceProviderProofStatusWorkflow = readFileSync(
  resolve(".github/workflows/marketplace-provider-proof-status.yml"),
  "utf8",
);
const platformStagingWakeDrillsWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-wake-drills.yml"),
  "utf8",
);
const platformStagingRouteMatrixEvidenceWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-route-matrix-evidence.yml"),
  "utf8",
);
const platformRepresentativeWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-representative-commerce-state.yml"),
  "utf8",
);
const adminWebViteConfig = readFileSync(resolve("deployables/admin-web/vite.config.ts"), "utf8");

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function hasSpacesBackendCredentials(source) {
  return (
    source.includes("AWS_ACCESS_KEY_ID: ${{ secrets.SPACES_ACCESS_ID }}") &&
    source.includes("AWS_SECRET_ACCESS_KEY: ${{ secrets.SPACES_SECRET_KEY }}")
  );
}

function expectGuardedTerraformResource(source, resourceType, resourceName) {
  const declaration = `resource "${resourceType}" "${resourceName}" {`;
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextBlockStart =
    [
      source.indexOf("\nresource ", start + declaration.length),
      source.indexOf("\ncheck ", start + declaration.length),
      source.indexOf("\nmoved ", start + declaration.length),
    ]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? source.length;
  const resource = source.slice(start, nextBlockStart);

  expect(resource).toContain("lifecycle {");
  expect(resource).toContain("prevent_destroy = true");
}

function listFilesRecursively(rootDir, prefix = "") {
  return readdirSync(rootDir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(rootDir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFilesRecursively(entryPath, relativePath) : [relativePath];
    })
    .sort((left, right) => left.localeCompare(right));
}

function expectTerraformAssignment(source, localName, expression) {
  expect(source).toMatch(new RegExp(`${localName}\\s+=\\s+${expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}

describe("DigitalOcean platform runbook", () => {
  it("documents the database companion sequence for deployable profiles", () => {
    expect(digitaloceanPlatformRunbook).toContain(
      "Database lifecycle is a companion track to runtime profile migration, not a side effect of it.",
    );
    expect(digitaloceanPlatformRunbook).toContain("`provisioned_context_names`, `active_runtime_context_names`");
    expect(digitaloceanPlatformRunbook).toContain(
      "Topology/release-health evidence for profile migration must include",
    );
    expect(digitaloceanPlatformRunbook).toContain("projection rebuild for derived read models");

    expect(deployableProfileDatabaseCompanion).toContain(
      "Deployable profiles control which runtime slices are mounted",
    );
    expect(deployableProfileDatabaseCompanion).toContain(
      "Separate provisioned, active, and exposed context sets (#3223)",
    );
    expect(deployableProfileDatabaseCompanion).toContain("Publish profile-aware connection budget output (#3225)");
    expect(deployableProfileDatabaseCompanion).toContain(
      "Converge production query traffic onto managed transaction pools",
    );
    expect(deployableProfileDatabaseCompanion).toContain("projection rebuild, PITR/backups, or precreated fork");
  });
});

describe("Production PgBouncer session-safety audit", () => {
  it("documents the landed production transaction-pool posture and direct-only exceptions", () => {
    expect(productionPgBouncerSessionSafety).toContain(
      "Production `DATABASE_URL_*` query traffic runs through DigitalOcean transaction-mode PgBouncer pools.",
    );
    expect(productionPgBouncerSessionSafety).toContain(
      "converged production query traffic onto managed transaction pools",
    );
    expect(productionPgBouncerSessionSafety).toContain("Context-owned durable/realtime waiters");
    expect(productionPgBouncerSessionSafety).toContain("DATABASE_URL_<CONTEXT>_WAITER");
    expect(productionPgBouncerSessionSafety).toContain("Projection wake relay source listeners");
    expect(productionPgBouncerSessionSafety).toContain("Direct-only and least-privilege; never transaction-pooled.");
    expect(productionPgBouncerSessionSafety).toContain(
      "Add Terraform-managed production transaction pools only for query-safe traffic.",
    );
    // Session-state audit: the event-append lock is transaction-scoped and the
    // only session-scoped path (schema bootstrap) stays direct.
    expect(productionPgBouncerSessionSafety).toContain("pg_advisory_xact_lock");
    expect(productionPgBouncerSessionSafety).toContain("schema bootstrap");
  });
});

function workflowStep(source, stepName) {
  const start = source.indexOf(`- name: ${stepName}`);
  expect(start).not.toBe(-1);

  const next = source.indexOf("\n      - name:", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function workflowEnvironmentExpression(step, variableName) {
  const match = step.match(new RegExp(`^\\s+${variableName}:\\s+(.+)$`, "m"));
  expect(match).not.toBeNull();
  return match[1];
}

function evaluateRestorePointWorkflowExpression(expression, { eventName, emergencyRelease, restorePointRequired }) {
  const match = expression.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
  expect(match).not.toBeNull();

  const javascriptExpression = match[1]
    .replaceAll("github.event_name", JSON.stringify(eventName))
    .replaceAll("inputs.emergency_release", JSON.stringify(emergencyRelease))
    .replaceAll(
      "needs.resolve-release.outputs.production_restore_point_required",
      JSON.stringify(restorePointRequired),
    );

  return Function(`"use strict"; return (${javascriptExpression});`)();
}

function stagingResumeInverseGateViolations(source) {
  const gate = workflowStep(source, "Fail closed unless staging is absent for resume");
  const requirements = [
    ["resume-only condition", "if: inputs.mode == 'resume-recreate'"],
    ["Terraform state app/database absence", "digitalocean_(app\\.platform|database_cluster\\.postgres)"],
    ["DigitalOcean database absence", 'any(.[]; .name == "chase-sets-staging-postgres")'],
    ["DigitalOcean app absence", 'any(.[]; .spec.name == "chase-sets-staging-platform")'],
    ["admin readiness 5xx-only result", '[[ ! "$admin_status" =~ ^5[0-9][0-9]$ ]]'],
    ["three consecutive admin probes", "for attempt in 1 2 3"],
  ];

  return requirements.filter(([, fragment]) => !gate.includes(fragment)).map(([description]) => description);
}

function workflowSteps(source, stepName) {
  const steps = [];
  const stepPattern = new RegExp(`- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm");
  let match = stepPattern.exec(source);
  while (match) {
    const start = match.index;
    const next = source.indexOf("\n      - name:", start + 1);
    steps.push(next === -1 ? source.slice(start) : source.slice(start, next));
    match = stepPattern.exec(source);
  }
  expect(steps.length).toBeGreaterThan(0);
  return steps;
}

function terraformResourceBlock(source, type, name) {
  const marker = `resource "${type}" "${name}" {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Terraform resource ${type}.${name} was not found.`);
  const nextResource = source.indexOf('\nresource "', start + marker.length);
  return source.slice(start, nextResource < 0 ? source.length : nextResource);
}

function carriesExactProviderCredentials(step) {
  return [
    "TF_VAR_digitalocean_token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
    "TF_VAR_spaces_access_id: ${{ secrets.SPACES_ACCESS_ID }}",
    "TF_VAR_spaces_secret_key: ${{ secrets.SPACES_SECRET_KEY }}",
  ].every((binding) => step.includes(binding));
}

function isExactManagedPostgresGrantTrustPlan(plan) {
  const changed = (plan.resource_changes ?? []).filter((resource) =>
    (resource.change?.actions ?? []).some((action) => !["no-op", "read"].includes(action)),
  );
  return (
    JSON.stringify(
      changed.map(({ address, type, provider_name: providerName, change }) => ({
        address,
        type,
        providerName,
        actions: change.actions,
      })),
    ) ===
    JSON.stringify([
      {
        address: "terraform_data.context_database_grants[0]",
        type: "terraform_data",
        providerName: "terraform.io/builtin/terraform",
        actions: ["delete", "create"],
      },
      {
        address: "terraform_data.wake_listener_database_grants[0]",
        type: "terraform_data",
        providerName: "terraform.io/builtin/terraform",
        actions: ["delete", "create"],
      },
    ])
  );
}

function workflowJob(source, jobName) {
  const match = new RegExp(`(^|\\n)  ${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).exec(source);
  expect(match).not.toBeNull();

  const start = match.index + match[1].length;
  const rest = source.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function workflowJobCondition(source, jobName) {
  const lines = workflowJob(source, jobName).replaceAll("\r\n", "\n").split("\n");
  const ifIndex = lines.findIndex((line) => line.startsWith("    if: "));
  expect(ifIndex).not.toBe(-1);

  if (lines[ifIndex] !== "    if: >") {
    return lines[ifIndex].slice("    if: ".length).trim();
  }

  const expressionLines = [];
  for (const line of lines.slice(ifIndex + 1)) {
    if (/^    \S/.test(line)) {
      break;
    }
    if (line.trim()) {
      expressionLines.push(line.trim());
    }
  }
  return expressionLines.join(" ");
}

function productionReconciliationNeedsSuccessfulStaging(source) {
  const job = workflowJob(source, "reconcile-managed-postgres-ca-production").replaceAll("\r\n", "\n");
  return (
    job.includes("    needs:\n      - resolve-release\n      - reconcile-managed-postgres-ca-staging\n") &&
    workflowJobCondition(source, "reconcile-managed-postgres-ca-production").includes(
      "needs['reconcile-managed-postgres-ca-staging'].result == 'success'",
    ) &&
    !job.includes("always()")
  );
}

function dayAfterManagedPostgresCaJobsAreEligible(source, scope) {
  const stagingCondition = workflowJobCondition(source, "reconcile-managed-postgres-ca-staging");
  const productionCondition = workflowJobCondition(source, "reconcile-managed-postgres-ca-production");
  return (
    scope.deployRequired === false &&
    stagingCondition === "needs.resolve-release.outputs.deployment_required != 'true'" &&
    productionCondition.includes("needs.resolve-release.outputs.deployment_required != 'true'") &&
    productionCondition.includes("needs['reconcile-managed-postgres-ca-staging'].result == 'success'")
  );
}

function workflowPrerequisite(condition, outputName, jobName) {
  const outputToken = `needs['change-scope'].outputs.${outputName}`;
  const jobToken = `needs['${jobName}'].result == 'success'`;
  const outputIndex = condition.indexOf(outputToken);
  expect(outputIndex).not.toBe(-1);
  const start = condition.lastIndexOf("(", outputIndex);
  const end = condition.indexOf(")", condition.indexOf(jobToken, outputIndex));
  expect(start).not.toBe(-1);
  expect(end).not.toBe(-1);
  return condition.slice(start, end + 1);
}

function evaluateWorkflowBooleanExpression(expression, values) {
  let javascriptExpression = expression;
  for (const [token, value] of Object.entries(values).sort(([left], [right]) => right.length - left.length)) {
    javascriptExpression = javascriptExpression.replaceAll(token, JSON.stringify(value));
  }
  expect(javascriptExpression).not.toMatch(/\b(?:needs|github|contains)\b/);
  expect(javascriptExpression).toMatch(/^[\s()!&|='"a-z]+$/);
  return Function(`"use strict"; return (${javascriptExpression});`)();
}

function workflowShellFunction(source, functionName) {
  const normalized = source.replaceAll("\r\n", "\n");
  const marker = `          ${functionName}() {`;
  const start = normalized.indexOf(marker);
  expect(start).not.toBe(-1);
  const end = normalized.indexOf("\n          }", start);
  expect(end).not.toBe(-1);
  return normalized.slice(start, end + "\n          }".length);
}

function workflowRequiredCall(source, jobName) {
  const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`^\\s+(require(?:_targeted_heavy|_heavy)?_job) "${escapedName}" "([^"]+)" "([^"]+)"$`, "m"),
  );
  expect(match).not.toBeNull();
  return { helper: match[1], resultArgument: match[2], requiredArgument: match[3], line: match[0].trim() };
}

function evaluateRequiredWorkflowCall(call, { templateValues, targetedHeavyRequired = false }) {
  const resolveArgument = (argument) => {
    const match = argument.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
    expect(match).not.toBeNull();
    expect(templateValues).toHaveProperty(match[1]);
    return templateValues[match[1]];
  };
  const result = resolveArgument(call.resultArgument);
  const affected = resolveArgument(call.requiredArgument) === "true";
  const required = call.helper === "require_targeted_heavy_job" ? targetedHeavyRequired && affected : affected;
  return required ? result === "success" : result === "skipped" || result === "success";
}

function terraformServiceBlock(source, serviceName) {
  const start = source.indexOf(`name               = "${serviceName}"`);
  expect(start).not.toBe(-1);

  const nextService = source.indexOf("\n    service", start + 1);
  const nextDynamicService = source.indexOf('\n    dynamic "service"', start + 1);
  const nextWorker = source.indexOf("\n    worker", start + 1);
  const nextDynamicWorker = source.indexOf('\n    dynamic "worker"', start + 1);
  const nextJob = source.indexOf("\n    job", start + 1);
  const nextDynamicJob = source.indexOf('\n    dynamic "job"', start + 1);
  const nextIngress = source.indexOf("\n    ingress", start + 1);
  const candidates = [
    nextService,
    nextDynamicService,
    nextWorker,
    nextDynamicWorker,
    nextJob,
    nextDynamicJob,
    nextIngress,
  ].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function terraformWorkerBlock(source, workerName) {
  const start = source.indexOf(`name               = "${workerName}"`);
  expect(start).not.toBe(-1);

  const nextWorker = source.indexOf("\n    worker", start + 1);
  const nextDynamicWorker = source.indexOf('\n    dynamic "worker"', start + 1);
  const nextJob = source.indexOf("\n    job", start + 1);
  const nextDynamicJob = source.indexOf('\n    dynamic "job"', start + 1);
  const nextIngress = source.indexOf("\n    ingress", start + 1);
  const candidates = [nextWorker, nextDynamicWorker, nextJob, nextDynamicJob, nextIngress].filter(
    (index) => index !== -1,
  );
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function terraformJobBlock(source, jobName) {
  const start = source.indexOf(`name               = "${jobName}"`);
  expect(start).not.toBe(-1);

  const nextJob = source.indexOf("\n    job", start + 1);
  const nextDynamicJob = source.indexOf('\n    dynamic "job"', start + 1);
  const nextIngress = source.indexOf("\n    ingress", start + 1);
  const candidates = [nextJob, nextDynamicJob, nextIngress].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function terraformStringList(source, localName) {
  const match = new RegExp(`${localName}\\s+=\\s+\\[([\\s\\S]*?)\\]`).exec(source);
  expect(match).not.toBeNull();
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function hotRelaySourceContextsFromRegistry(source) {
  return [...source.matchAll(/registryEntry\(\{([\s\S]*?)\n  \}\),/g)]
    .flatMap((entry) => {
      const sourceContextName = /sourceContextName:\s*"([^"]+)"/.exec(entry[1])?.[1];
      const hotLane = /priorityLane:\s*"hot"/.test(entry[1]);
      const relayFanOut = /relayFanOut:\s*true/.test(entry[1]);
      return sourceContextName && hotLane && relayFanOut ? [sourceContextName] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function directListenerSourceContextsFromRegistry(source) {
  return [...new Set([...hotRelaySourceContextsFromRegistry(source), "identity", "public-presence"])].sort(
    (left, right) => left.localeCompare(right),
  );
}

function terraformStringMap(source, localName) {
  const match = new RegExp(`${localName} = \\{([\\s\\S]*?)\\n  \\}`).exec(source);
  expect(match).not.toBeNull();
  return Object.fromEntries([...match[1].matchAll(/"([^"]+)"\s+=\s+"([^"]+)"/g)].map((entry) => [entry[1], entry[2]]));
}

function viteProxyPrefixes() {
  return [...adminWebViteConfig.matchAll(/"([^"]+)"\s*:\s*\{/g)]
    .map((entry) => entry[1])
    .filter((prefix) => prefix.startsWith("/api/"))
    .sort();
}

function pathCoveredByPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function platformApiContextNames() {
  return listContextManifests()
    .filter(({ manifest }) => manifest.apiDeployables?.includes("platform-api"))
    .map(({ dirName }) => dirName);
}

function platformApiRuntimeContextNames(runtimeProfile) {
  return listContextManifests()
    .filter(
      ({ manifest }) =>
        (manifest.apiDeployables?.includes("platform-api") && manifest.apiRuntimeProfiles?.includes(runtimeProfile)) ||
        (manifest.sourceRuntimeDeployables?.includes("platform-api") &&
          manifest.sourceRuntimeProfiles?.includes(runtimeProfile)),
    )
    .map(({ manifest }) => manifest.contextName)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function platformApiExposedContextNames(runtimeProfile) {
  return listContextManifests()
    .filter(
      ({ manifest }) =>
        manifest.apiDeployables?.includes("platform-api") && manifest.apiRuntimeProfiles?.includes(runtimeProfile),
    )
    .map(({ manifest }) => manifest.contextName)
    .sort((left, right) => left.localeCompare(right, "en"));
}

describe("DigitalOcean platform configuration", () => {
  it("threads the exact graph-owned authority and v2 trust trigger to both database-grant provisioners", () => {
    const contextGrants = terraformResourceBlock(platformMain, "terraform_data", "context_database_grants");
    const wakeListenerGrants = terraformResourceBlock(platformMain, "terraform_data", "wake_listener_database_grants");
    const expectedBindings = [
      "DIGITALOCEAN_ACCESS_TOKEN        = var.digitalocean_token",
      "DIGITALOCEAN_DATABASE_CLUSTER_ID = digitalocean_database_cluster.postgres[0].id",
      "PGHOST                           = digitalocean_database_cluster.postgres[0].host",
      "PGPASSWORD                       = digitalocean_database_cluster.postgres[0].password",
      "PGPORT                           = tostring(digitalocean_database_cluster.postgres[0].port)",
      "PGUSER                           = digitalocean_database_cluster.postgres[0].user",
    ];

    for (const resource of [contextGrants, wakeListenerGrants]) {
      expect(occurrenceCount(resource, '"managed-postgres-grant-trust-v2"')).toBe(1);
      expect(resource).toContain('command     = "node scripts/apply-digitalocean-database-grant.mjs"');
      for (const binding of expectedBindings) expect(resource).toContain(binding);
      expect(resource).not.toMatch(/\bPGDATABASE\s*=/);
      expect(resource).not.toMatch(/\bPGSSLMODE\s*=/);
      const command = /^\s*command\s*=\s*(.+)$/m.exec(resource)?.[1] ?? "";
      expect(command).not.toMatch(
        /DIGITALOCEAN_(?:ACCESS_TOKEN|DATABASE_CLUSTER_ID)|PGPASSWORD|DATABASE_GRANTS_JSON|--(?:cluster|token)/i,
      );
    }

    const providerSource = /digitalocean\s*=\s*\{[\s\S]*?source\s*=\s*"([^"]+)"/.exec(platformVersions)?.[1];
    expect(providerSource).toBe("digitalocean/digitalocean");
    expect(platformVariables).toMatch(
      /variable "digitalocean_token" \{\s*type\s*=\s*string\s*sensitive\s*=\s*true\s*\}/,
    );
  });

  it("models exactly the two v2 grant replacements and rejects one-variable plan/provider drift", () => {
    const plan = {
      resource_changes: [
        {
          address: "terraform_data.context_database_grants[0]",
          type: "terraform_data",
          name: "context_database_grants",
          provider_name: "terraform.io/builtin/terraform",
          change: { actions: ["delete", "create"] },
        },
        {
          address: "terraform_data.wake_listener_database_grants[0]",
          type: "terraform_data",
          name: "wake_listener_database_grants",
          provider_name: "terraform.io/builtin/terraform",
          change: { actions: ["delete", "create"] },
        },
        {
          address: "digitalocean_database_cluster.postgres[0]",
          type: "digitalocean_database_cluster",
          name: "postgres",
          provider_name: "registry.terraform.io/digitalocean/digitalocean",
          change: { actions: ["no-op"] },
        },
        {
          address: 'digitalocean_database_db.contexts["checkout"]',
          type: "digitalocean_database_db",
          name: "contexts",
          provider_name: "registry.terraform.io/digitalocean/digitalocean",
          change: { actions: ["no-op"] },
        },
        {
          address: 'digitalocean_database_user.contexts["checkout"]',
          type: "digitalocean_database_user",
          name: "contexts",
          provider_name: "registry.terraform.io/digitalocean/digitalocean",
          change: { actions: ["no-op"] },
        },
      ],
    };

    expect(isExactManagedPostgresGrantTrustPlan(plan)).toBe(true);
    expect(terraformPlanSummary(plan)).toMatchObject({ add: 2, change: 0, destroy: 2, omittedResources: 0 });
    for (const resource of plan.resource_changes.slice(2)) {
      expect(resource.provider_name).toBe("registry.terraform.io/digitalocean/digitalocean");
      expect(resource.change.actions).toEqual(["no-op"]);
    }

    const wrongProvider = structuredClone(plan);
    wrongProvider.resource_changes[0].provider_name = "registry.terraform.io/hashicorp/null";
    expect(isExactManagedPostgresGrantTrustPlan(wrongProvider)).toBe(false);
    const clusterReplacement = structuredClone(plan);
    clusterReplacement.resource_changes[2].change.actions = ["delete", "create"];
    expect(isExactManagedPostgresGrantTrustPlan(clusterReplacement)).toBe(false);
    const missingSibling = structuredClone(plan);
    missingSibling.resource_changes[1].change.actions = ["no-op"];
    expect(isExactManagedPostgresGrantTrustPlan(missingSibling)).toBe(false);
  });

  it("models pending-v2 execution, inert day-after state, and a later graph-owned replacement", () => {
    const replacementRequired = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
    const v1 = { clusterId: "cluster-a", grantIds: ["db-a:user-a"], trustVersion: "v1" };
    const v2 = {
      clusterId: "cluster-a",
      grantIds: ["db-a:user-a"],
      trustVersion: "managed-postgres-grant-trust-v2",
    };
    expect(replacementRequired(v1, v2)).toBe(true);
    expect(replacementRequired(v2, structuredClone(v2))).toBe(false);
    expect(replacementRequired(v2, { ...v2, grantIds: ["db-a:user-b"] })).toBe(true);
    expect(JSON.stringify(v2)).not.toMatch(/certificate|BEGIN CERTIFICATE|sha256|fingerprint/i);

    const literalRemovalMutant = platformMain.replaceAll('"managed-postgres-grant-trust-v2",', "");
    for (const name of ["context_database_grants", "wake_listener_database_grants"]) {
      expect(terraformResourceBlock(literalRemovalMutant, "terraform_data", name)).not.toContain(
        "managed-postgres-grant-trust-v2",
      );
    }
  });

  it("keeps environment approval followed by one same-job tfplan and applies those exact bytes", () => {
    for (const jobName of ["deploy-staging", "deploy-production"]) {
      const job = workflowJob(platformProductionWorkflow, jobName);
      const planStep = workflowStep(job, "Terraform plan");
      const applyStep = workflowSteps(job, "Terraform apply").at(-1);
      expect(job).toContain(`environment: ${jobName === "deploy-staging" ? "staging" : "production"}`);
      expect(planStep).toContain("working-directory: infrastructure/digitalocean/platform");
      expect(planStep).toContain("terraform plan -out=tfplan");
      expect(applyStep).toContain("working-directory: infrastructure/digitalocean/platform");
      expect(applyStep).toContain("terraform apply -auto-approve tfplan");
      expect(applyStep).not.toMatch(/terraform\s+plan/);
      expect(job.indexOf(planStep)).toBeLessThan(job.indexOf(applyStep));
    }
  });

  it("retires application compute while preserving live DOKS DNS addresses", () => {
    expect(platformMain).not.toMatch(/resource\s+"digitalocean_app"/);
    expect(platformProjects).not.toContain("digitalocean_app.platform.urn");
    expect(platformMain).toContain('resource "digitalocean_record" "app_serving"');
    expect(platformMain).toContain('resource "digitalocean_record" "doks_apex"');
    expect(platformMain).toContain("value  = var.doks_ingress_target");
    expect(platformLocals).toContain('production_retained_connection_pool_context_names = ["marketplace"]');
    expect(platformMain).toContain('comparison = "less_than"');
    expect(platformMain).toContain("threshold  = 1");
    expect(environmentDnsVariables).not.toMatch(/app_serving/);
    expect(environmentDnsMain).not.toMatch(/staging_app_alias/);
  });

  it("keeps decommission planning read-only with the exact owner approval", () => {
    const decommissionJob = workflowJob(platformProductionWorkflow, "decommission-live-plan");
    expect(decommissionJob).toContain("landing/staging.tfstate");
    expect(decommissionJob).toContain("landing/production.tfstate");
    expect(decommissionJob).toContain("digitalocean_app.platform");
    expect(decommissionJob).toContain("terraform_data.production_app_platform_parking_preparation[0]");
    expect(decommissionJob).toContain("terraform_data.production_serving_dns_ttl_preparation[0]");
    expect(decommissionJob).toContain("sha256:6eefaf301867bc08a35bbca0e5b9a68874eaabd2c0970239f2b30e15212cdf29");
    expect(decommissionJob).not.toMatch(/terraform\s+apply/);
    expect(existsSync(resolve(".github/deployment/production-destructive-change-approved.md"))).toBe(true);
  });

  it("requires the active matching approval for the staging delete gate", () => {
    const stagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const stagingPlanStep = workflowStep(stagingJob, "Terraform plan");
    const stagingPlan = {
      resource_changes: [
        {
          address: "digitalocean_app.platform",
          type: "digitalocean_app",
          name: "platform",
          change: { actions: ["delete"] },
        },
      ],
    };

    expect(stagingJob).toContain(
      "DESTRUCTIVE_CHANGE_ALLOW_FILE: .github/deployment/production-destructive-change-approved.md",
    );
    expect(stagingPlanStep).toContain(
      'assert-no-destructive-changes tfplan --allow-file="../../../${DESTRUCTIVE_CHANGE_ALLOW_FILE}"',
    );
    expect(() => assertNoDestructiveChanges(stagingPlan)).toThrow(
      "Terraform plan contains destructive changes and no reviewed override marker was found",
    );
    const approval = destructiveChangeApprovalFromText(
      readFileSync(resolve(".github/deployment/production-destructive-change-approved.md"), "utf8"),
    );
    expect(approval).toEqual({
      state: "active",
      planFingerprint: "sha256:6eefaf301867bc08a35bbca0e5b9a68874eaabd2c0970239f2b30e15212cdf29",
      addresses: ["digitalocean_app.platform"],
    });
    expect(assertNoDestructiveChanges(stagingPlan, { destructiveChangeApproval: approval })).toEqual([
      {
        address: "digitalocean_app.platform",
        type: "digitalocean_app",
        name: "platform",
        actions: ["delete"],
      },
    ]);
  });

  it("renders DOKS from the checked-in runtime contract", () => {
    expect(JSON.parse(platformRuntimeValues).schemaVersion).toBe("platform-runtime-values/v1");
    expect(renderPlatformHelmValuesScript).toContain("runtime-values.json");
    expect(renderPlatformHelmValuesScript).not.toContain("digitalocean_app");
  });

  it("keeps staging landing under the environment namespace with the legacy dash host retired (#5568)", () => {
    expect(platformLocals).toContain('local.is_staging ? "www.${var.environment}.${var.root_domain}"');
    expect(platformLocals).not.toContain('local.is_staging ? "${var.environment}.${var.root_domain}"');
    expect(platformLocals).not.toContain("legacy_domain_redirects");
    expect(platformLocals).not.toContain("legacy_public_redirect_domains");
    expect(platformMain).not.toContain("legacy_domain_redirects");
    expect(platformOutputs).not.toContain("legacy_public_redirect_domains");
  });

  it("uploads support-safe representative commerce selector evidence", () => {
    const refreshStep = workflowStep(platformRepresentativeWorkflow, "Run representative commerce state refresh");
    const uploadStep = workflowStep(platformRepresentativeWorkflow, "Upload representative commerce selector evidence");

    expect(platformRepresentativeWorkflow).toContain(
      "REPRESENTATIVE_COMMERCE_STATE_EVIDENCE_OUT: ${{ github.workspace }}/artifacts/representative-commerce-state/representative-commerce-state-evidence.json",
    );
    expect(refreshStep).toContain("mkdir -p artifacts/representative-commerce-state");
    expect(refreshStep).toContain(
      "pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production",
    );
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("name: representative-commerce-state-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(uploadStep).toContain("path: artifacts/representative-commerce-state");
    expect(uploadStep).toContain("if-no-files-found: error");
  });

  it("parses the production Postgres cluster id from indented Terraform state fallback output", () => {
    const restorePointStep = workflowStep(platformProductionWorkflow, "Create production database restore point");

    expect(restorePointStep).toContain("terraform output -raw postgres_cluster_id");
    expect(restorePointStep).toContain("terraform state list");
    expect(restorePointStep).toContain(`awk '/(^|\\.)digitalocean_database_cluster\\./ { print; exit }'`);
    expect(restorePointStep).toContain("Using production database cluster Terraform state address");
    expect(restorePointStep).toContain(`terraform state show -no-color "$database_cluster_address"`);
    expect(restorePointStep).toContain(`awk -F '='`);
    expect(restorePointStep).toContain(`gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)`);
    expect(restorePointStep).toContain(`key == "id"`);
    expect(restorePointStep).toContain(`gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", value)`);
    expect(restorePointStep).toContain("[ -f tfplan ]");
    expect(restorePointStep).toContain(
      "node ../../../scripts/terraform-plan-inspection.mjs postgres-cluster-id tfplan",
    );
    expect(restorePointStep).toContain("Using production database cluster id from Terraform plan.");
    expect(restorePointStep).toContain("git fetch origin production");
    expect(restorePointStep).toContain('pre_migrate_state_key="production-marker:${production_marker_commit}"');
    expect(restorePointStep).toContain('--pre-migrate-state-key "$pre_migrate_state_key"');
  });

  it("gives an audited emergency restore-point bypass precedence over the routine PITR skip (#6270)", () => {
    const restorePointStep = workflowStep(platformProductionWorkflow, "Create production database restore point");
    const incidentContext = {
      eventName: "workflow_dispatch",
      emergencyRelease: true,
      restorePointRequired: "false",
    };
    const bypassExpression = workflowEnvironmentExpression(restorePointStep, "PRODUCTION_DB_RESTORE_POINT_BYPASS");
    const skipExpression = workflowEnvironmentExpression(restorePointStep, "PRODUCTION_DB_RESTORE_POINT_SKIP");

    expect({
      bypass: evaluateRestorePointWorkflowExpression(bypassExpression, incidentContext),
      skip: evaluateRestorePointWorkflowExpression(skipExpression, incidentContext),
    }).toEqual({
      bypass: "true",
      skip: "false",
    });

    const predecessorSkipExpression =
      "${{ needs.resolve-release.outputs.production_restore_point_required == 'true' && 'false' || 'true' }}";
    expect(evaluateRestorePointWorkflowExpression(predecessorSkipExpression, incidentContext)).toBe("true");
  });

  it("reaps production restore-point forks on a six-hour cleanup window", () => {
    expect(platformProductionRestorePointCleanupWorkflow).toContain('cron: "17 3,9,15,21 * * *"');
    expect(platformProductionRestorePointCleanupWorkflow).toContain('default: "6"');
    expect(platformProductionRestorePointCleanupWorkflow).toContain(
      `MIN_AGE_HOURS: \${{ github.event.inputs.min_age_hours || '6' }}`,
    );
    expect(platformProductionRestorePointCleanupWorkflow).toContain('--min-age-hours "$MIN_AGE_HOURS"');
    expect(platformProductionRestorePointCleanupWorkflow).toContain("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES");
  });

  it("gates a destructive staging reset on the support-safe staging-refresh preflight", () => {
    const preflightStep = workflowStep(
      platformStagingResetWorkflow,
      "Gate staging refresh provider and set-matrix preflight",
    );

    expect(platformStagingResetWorkflow).toContain("allow_scrydex_usage_check:");
    expect(platformStagingResetWorkflow).toContain("confirm_no_staging_evidence_overlap:");
    expect(platformStagingResetWorkflow).toContain("actions: read");
    expect(preflightStep).toContain("if: inputs.mode == 'full-reset'");
    expect(preflightStep).toContain("node ./scripts/staging-refresh-preflight.mjs");
    expect(preflightStep).toContain("--skip-github-metadata");
    expect(preflightStep).toContain("--skip-deployed-secret-check");
    expect(preflightStep).toContain("STAGING_REFRESH_ALLOW_CREDITED_PROVIDER_READS");
    expect(preflightStep).toContain("STAGING_REFRESH_NO_SCHEDULED_OVERLAP_CONFIRMED");
    expect(preflightStep).toContain("TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE");
    expect(preflightStep).toContain("SCRYDEX_API_KEY");
    expect(preflightStep).toContain("STRIPE_SECRET_KEY");
    expect(preflightStep).toContain("EASYPOST_API_KEY");
    expect(platformStagingResetWorkflow.indexOf("Gate staging refresh provider and set-matrix preflight")).toBeLessThan(
      platformStagingResetWorkflow.indexOf("Terraform init staging environment DNS"),
    );
    expect(platformStagingResetWorkflow).toContain("staging-refresh-preflight-${{ github.run_id }}");

    const overlapRecheckStep = workflowStep(
      platformStagingResetWorkflow,
      "Re-check staging refresh overlap before destroy",
    );
    expect(overlapRecheckStep).toContain("if: inputs.mode == 'full-reset'");
    expect(overlapRecheckStep).toContain("node ./scripts/staging-refresh-preflight.mjs --overlap-only");
    const overlapRecheckIndex = platformStagingResetWorkflow.indexOf(
      "- name: Re-check staging refresh overlap before destroy",
    );
    const destroyIndex = platformStagingResetWorkflow.indexOf("- name: Terraform destroy staging platform");
    expect(overlapRecheckIndex).toBeLessThan(destroyIndex);
    expect(platformStagingResetWorkflow.slice(overlapRecheckIndex, destroyIndex).match(/^\s*- name:/gm)).toHaveLength(
      1,
    );
  });

  it("resumes recreation only after a fail-closed staging absence proof", () => {
    expect(platformStagingResetWorkflow).toContain("mode:");
    expect(platformStagingResetWorkflow).toContain("default: full-reset");
    expect(platformStagingResetWorkflow).toContain("- resume-recreate");

    const inverseGateStep = workflowStep(
      platformStagingResetWorkflow,
      "Fail closed unless staging is absent for resume",
    );
    expect(inverseGateStep).toContain("if: inputs.mode == 'resume-recreate'");
    expect(inverseGateStep).toContain("terraform state list");
    expect(inverseGateStep).toContain("digitalocean_(app\\.platform|database_cluster\\.postgres)");
    expect(inverseGateStep).toContain("doctl databases list --output json");
    expect(inverseGateStep).toContain('any(.[]; .name == "chase-sets-staging-postgres")');
    expect(inverseGateStep).toContain("doctl apps list --output json");
    expect(inverseGateStep).toContain('any(.[]; .spec.name == "chase-sets-staging-platform")');
    expect(inverseGateStep).toContain("https://admin.staging.chasesets.com/api/health/ready");
    expect(inverseGateStep).toContain('[[ ! "$admin_status" =~ ^5[0-9][0-9]$ ]]');
    expect(inverseGateStep).toContain("for attempt in 1 2 3");
    expect(stagingResumeInverseGateViolations(platformStagingResetWorkflow)).toEqual([]);

    const preflightStep = workflowStep(
      platformStagingResetWorkflow,
      "Gate staging refresh provider and set-matrix preflight",
    );
    expect(preflightStep).toContain("if: inputs.mode == 'full-reset'");
    const preflightUploadStep = workflowStep(platformStagingResetWorkflow, "Upload staging refresh preflight evidence");
    expect(preflightUploadStep).toContain("inputs.mode == 'full-reset'");
    expect(platformStagingResetWorkflow.indexOf("Fail closed unless staging is absent for resume")).toBeLessThan(
      platformStagingResetWorkflow.indexOf("Terraform destroy staging platform"),
    );

    const sharedResetBackHalf = platformStagingResetWorkflow.slice(
      platformStagingResetWorkflow.indexOf("- name: Terraform destroy staging platform"),
    );
    expect(sharedResetBackHalf).not.toContain("inputs.mode");
    expect(sharedResetBackHalf).toContain("- name: Terraform plan staging recreate");
    expect(sharedResetBackHalf).toContain("- name: Terraform apply staging recreate");
    expect(sharedResetBackHalf).toContain("- name: Queue DOKS redeploy after database recreation");
  });

  it("negative control: rejects a resume gate that would accept healthy admin readiness", () => {
    const weakenedWorkflow = platformStagingResetWorkflow.replace(
      '[[ ! "$admin_status" =~ ^5[0-9][0-9]$ ]]',
      '[[ ! "$admin_status" =~ ^[25][0-9][0-9]$ ]]',
    );
    expect(weakenedWorkflow).not.toBe(platformStagingResetWorkflow);
    expect(stagingResumeInverseGateViolations(weakenedWorkflow)).toContain("admin readiness 5xx-only result");
  });

  it("keeps shared Catalog asset buckets and CDN domains in their own stable root", () => {
    expect(catalogAssetsMain).toContain('resource "digitalocean_spaces_bucket" "catalog_assets"');
    expect(catalogAssetsMain).toContain('acl           = "private"');
    expect(catalogAssetsMain).toContain("prevent_destroy = true");
    expect(catalogAssetsMain).toContain('resource "digitalocean_cdn" "catalog_assets"');
    expect(catalogAssetsMain).toContain('resource "digitalocean_certificate" "catalog_assets_cdn"');
    expect(catalogAssetsMain).not.toContain("digitalocean_record");
    expect(catalogAssetsLocals).toContain('preview    = "chase-sets-preview-catalog-assets"');
    expect(catalogAssetsLocals).toContain('staging    = "assets.staging.${var.root_domain}"');
    expect(catalogAssetsLocals).toContain('production = "assets.${var.root_domain}"');
    expect(platformStagingResetWorkflow).toContain("Verify staging catalog asset CDN");
    expect(platformStagingResetWorkflow).toContain("disable-terraform-prevent-destroy.mjs main.tf");
    expect(platformStagingResetWorkflow).toContain("terraform import digitalocean_cdn.catalog_assets");
    expect(platformStagingResetWorkflow).toContain("doctl compute cdn list --output json");
    expect(platformStagingResetWorkflow).toContain('record_name="${custom_domain%.staging.chasesets.com}"');
    expect(platformStagingResetWorkflow).toContain(
      "doctl compute domain records list staging.chasesets.com --output json",
    );
    expect(platformStagingResetWorkflow).toContain("Catalog asset CDN root must stay protected; expected 403");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("repair catalog-assets cdn state");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("doctl compute cdn list --output json");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("terraform state rm digitalocean_cdn.catalog_assets");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("terraform import digitalocean_cdn.catalog_assets");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("Terraform state points at an existing CDN");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("recreate-missing");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain(
      "Recreate plan must contain only creation of digitalocean_cdn.catalog_assets.",
    );
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("terraform apply -auto-approve tfplan");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("timeout-minutes: 60");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("deadline=$((SECONDS + 2700))");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("protected HTTPS 403 within 45 minutes");
    expect(platformProductionWorkflow).toContain("catalog_asset_public_base_url");
    expect(platformProductionWorkflow).toContain("Catalog asset CDN root returned expected protected status 403.");
    expect(platformProductionWorkflow).not.toContain('"${catalog_asset_public_base_url}/" >/dev/null');
  });

  it("pins destroy guards on every durable DigitalOcean state root and preserves object delivery", () => {
    expectGuardedTerraformResource(platformMain, "digitalocean_database_cluster", "postgres");
    expectGuardedTerraformResource(observabilityMain, "digitalocean_volume", "observability_data");
    expectGuardedTerraformResource(catalogAssetsMain, "digitalocean_spaces_bucket", "catalog_assets");
    expectGuardedTerraformResource(stateBootstrapMain, "digitalocean_spaces_bucket", "terraform_state");
    expectGuardedTerraformResource(doksMain, "digitalocean_kubernetes_cluster", "platform");
    expectGuardedTerraformResource(environmentDnsMain, "digitalocean_domain", "environment");

    expect(objectStorageMain).toContain('ACL: "public-read"');
    expect(digitaloceanPlatformRunbook).toContain("Stateful Destroy Guard Override");
    expect(digitaloceanPlatformRunbook).toContain("temporary source edit locally");
  });

  it("waits for post-deploy projection readiness before production smoke asserts", () => {
    const exportStep = workflowStep(platformProductionWorkflow, "Export production readiness database URLs");
    const readinessStep = workflowStep(platformProductionWorkflow, "Production post-deploy readiness gate");
    const cleanupStep = workflowStep(platformProductionWorkflow, "Remove managed Postgres CA");

    // Ordering: before the smoke check and Stage 1 canary, so projection-
    // dependent production smoke assertions measure steady state (#4012).
    const smokeIndex = platformProductionWorkflow.lastIndexOf("- name: Smoke check");
    const exportIndex = platformProductionWorkflow.indexOf("- name: Export production readiness database URLs");
    const readinessIndex = platformProductionWorkflow.indexOf("- name: Production post-deploy readiness gate");
    const cleanupIndex = platformProductionWorkflow.indexOf("- name: Remove managed Postgres CA", readinessIndex);
    const stage1Index = platformProductionWorkflow.indexOf("- name: Stage 1 production canary");
    expect(exportIndex).toBeLessThan(readinessIndex);
    expect(readinessIndex).toBeLessThan(cleanupIndex);
    expect(cleanupIndex).toBeLessThan(smokeIndex);
    expect(readinessIndex).toBeLessThan(smokeIndex);
    expect(readinessIndex).toBeLessThan(stage1Index);

    // The export step delegates the canonical trust-bearing Terraform-state path.
    expect(exportStep).toContain("uses: ./.github/actions/export-managed-postgres-authority");
    expect(exportStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(exportStep).toContain("environment: production");
    expect(exportStep).toContain(
      "contexts: ${{ format('{0},checkout,public-presence,control', vars.PRODUCTION_READINESS_GATE_SOURCE_CONTEXTS || 'checkout,public-presence') }}",
    );
    expect(exportStep).not.toContain("sslmode=require");
    expect(exportManagedPostgresAuthorityAction).toContain("terraform state pull");
    expect(exportManagedPostgresAuthorityAction).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
    expect(exportManagedPostgresAuthorityAction).toContain('--ca-path "$MANAGED_POSTGRES_CA_PATH"');
    expect(exportStep).toContain("if: env.SHOULD_DEPLOY != 'false'");
    expect(exportStep).not.toContain("vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true'");
    expect(exportStep).toContain("continue-on-error: true");
    expect(cleanupStep).toContain("if: always() && env.SHOULD_DEPLOY != 'false'");
    expect(cleanupStep).toContain('rm -f -- "$MANAGED_POSTGRES_CA_PATH"');

    // The gate records the bounded outcome and fails closed before
    // projection-dependent smoke assertions when the budget expires.
    expect(readinessStep).toContain("node ./scripts/production-readiness-gate.mjs");
    expect(readinessStep).toContain(
      "READINESS_GATE_SOURCE_CONTEXTS: ${{ vars.PRODUCTION_READINESS_GATE_SOURCE_CONTEXTS || 'checkout,public-presence' }}",
    );
    expect(readinessStep).toContain(
      "READINESS_GATE_BUDGET_MS: ${{ vars.PRODUCTION_READINESS_GATE_BUDGET_MS || '300000' }}",
    );
    expect(readinessStep).toContain("set +e");
    expect(readinessStep).toContain('echo "outcome=${outcome}" >> "$GITHUB_OUTPUT"');
    expect(readinessStep).toContain("failing closed before projection-dependent smoke assertions");
    expect(readinessStep).not.toContain("exit 1");
    expect(readinessStep).toContain('exit "$gate_exit"');
    expect(readinessStep).toContain("artifacts/release-health/production-readiness-gate.json");
    expect(platformProductionWorkflow).toContain("artifacts/release-health/production-readiness-gate.json");
  });

  it("reconciles managed Postgres CA trust exactly once per staging and production deploy before Helm selection", () => {
    const credentialNames = [
      "TF_VAR_digitalocean_token",
      "TF_VAR_spaces_access_id",
      "TF_VAR_spaces_secret_key",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "DIGITALOCEAN_ACCESS_TOKEN",
    ];
    const stagingTrust = workflowStep(platformProductionWorkflow, "Reconcile staging managed Postgres CA trust");
    const productionTrust = workflowStep(platformProductionWorkflow, "Reconcile production managed Postgres CA trust");
    const stagingUrlExport = workflowStep(platformProductionWorkflow, "Export staging Kubernetes database URLs");
    const productionUrlExport = workflowStep(platformProductionWorkflow, "Export production Kubernetes database URLs");

    for (const [environment, step] of [
      ["staging", stagingTrust],
      ["production", productionTrust],
    ]) {
      expect(step).toContain("uses: ./.github/actions/export-managed-postgres-authority");
      expect(step).toContain("mode: trust-only-kubernetes-secret");
      expect(step).toContain(`environment: ${environment}`);
      expect(step).toContain("namespace: ${{ env.CHASE_SETS_KUBERNETES_NAMESPACE }}");
      for (const credential of credentialNames) expect(step).toContain(`${credential}:`);
      expect(step).not.toContain("contexts:");
      expect(step).not.toContain("connection-mode:");
    }
    expect(workflowSteps(platformProductionWorkflow, "Reconcile staging managed Postgres CA trust")).toHaveLength(1);
    expect(workflowSteps(platformProductionWorkflow, "Reconcile production managed Postgres CA trust")).toHaveLength(1);
    expect(stagingUrlExport).not.toContain("DIGITALOCEAN_ACCESS_TOKEN:");
    expect(productionUrlExport).not.toContain("DIGITALOCEAN_ACCESS_TOKEN:");

    const stagingSecret = platformProductionWorkflow.indexOf("- name: Apply staging Kubernetes runtime secrets");
    const stagingTrustIndex = platformProductionWorkflow.indexOf("- name: Reconcile staging managed Postgres CA trust");
    const stagingHelm = platformProductionWorkflow.indexOf("- name: Deploy staging Kubernetes release");
    expect(stagingSecret).toBeLessThan(stagingTrustIndex);
    expect(stagingTrustIndex).toBeLessThan(stagingHelm);

    const productionSecret = platformProductionWorkflow.indexOf("- name: Apply production Kubernetes runtime secrets");
    const productionTrustIndex = platformProductionWorkflow.indexOf(
      "- name: Reconcile production managed Postgres CA trust",
    );
    const productionRollbackTarget = platformProductionWorkflow.indexOf("- name: Capture production rollback target");
    const productionTerraformApply = platformProductionWorkflow.indexOf(
      "- name: Terraform apply",
      productionRollbackTarget,
    );
    const productionRollbackReadiness = platformProductionWorkflow.indexOf(
      "- name: Evaluate production rollback readiness",
    );
    const productionHelm = platformProductionWorkflow.indexOf("- name: Deploy production Kubernetes release");
    expect(productionRollbackTarget).toBeLessThan(productionTerraformApply);
    expect(productionSecret).toBeLessThan(productionTrustIndex);
    expect(productionTrustIndex).toBeLessThan(productionRollbackReadiness);
    expect(productionRollbackReadiness).toBeLessThan(productionHelm);
  });

  it("rolls day-after managed Postgres CA changes through staging before production", () => {
    const stagingJob = workflowJob(platformProductionWorkflow, "reconcile-managed-postgres-ca-staging");
    const productionJob = workflowJob(platformProductionWorkflow, "reconcile-managed-postgres-ca-production");
    const stagingGate = workflowStep(productionJob, "Require successful staging managed Postgres CA reconciliation");
    const stagingReceipt = workflowStep(stagingJob, "Record successful staging managed Postgres CA reconciliation");
    const stagingPublish = workflowStep(stagingJob, "Publish successful staging managed Postgres CA reconciliation");

    expect(stagingJob).toContain("environment: staging");
    expect(stagingJob).toContain("group: platform-deploy-staging");
    expect(productionJob).toContain("environment: production");
    expect(productionJob).toContain("group: platform-deploy-production");
    expect(stagingJob).not.toContain("matrix:");
    expect(productionJob).not.toContain("matrix:");
    expect(productionReconciliationNeedsSuccessfulStaging(platformProductionWorkflow)).toBe(true);

    const dependencyLine = "      - reconcile-managed-postgres-ca-staging\n";
    expect(occurrenceCount(platformProductionWorkflow.replaceAll("\r\n", "\n"), dependencyLine)).toBe(1);
    const dependencyRemovalMutant = platformProductionWorkflow.replaceAll("\r\n", "\n").replace(dependencyLine, "");
    expect(productionReconciliationNeedsSuccessfulStaging(dependencyRemovalMutant)).toBe(false);

    expect(stagingGate).toContain("uses: actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131");
    expect(stagingGate).toContain("name: managed-postgres-ca-staging-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(productionJob.indexOf(stagingGate)).toBeLessThan(productionJob.indexOf("digitalocean/action-doctl"));
    expect(productionJob.indexOf(stagingGate)).toBeLessThan(
      productionJob.indexOf(workflowStep(productionJob, "Reconcile day-after managed Postgres CA trust")),
    );

    for (const [environment, job] of [
      ["staging", stagingJob],
      ["production", productionJob],
    ]) {
      const trustStep = workflowStep(job, "Reconcile day-after managed Postgres CA trust");
      const rolloutEvaluation = workflowStep(job, "Evaluate managed Postgres CA pod-template reconciliation");
      const rolloutStep = workflowStep(job, "Reconcile managed Postgres CA pod templates");
      expect(trustStep).toContain("uses: ./.github/actions/export-managed-postgres-authority");
      expect(trustStep).toContain("mode: trust-only-kubernetes-secret");
      expect(trustStep).toContain(`environment: ${environment}`);
      expect(rolloutEvaluation).toContain('helm get values "$CHASE_SETS_HELM_RELEASE"');
      expect(rolloutEvaluation).toContain(".global.managedPostgresCaSha256 // empty");
      expect(rolloutEvaluation).toContain(
        'desired="${{ steps.managed_postgres_ca.outputs.managed-postgres-ca-sha256 }}"',
      );
      expect(rolloutEvaluation).toContain('if [ "$deployed" = "$desired" ]; then');
      expect(rolloutEvaluation).toContain('echo "changed=false"');
      expect(rolloutEvaluation).toContain('echo "changed=true"');
      expect(rolloutStep).toContain("if: steps.managed_postgres_ca_rollout.outputs.changed == 'true'");
      expect(rolloutStep).toContain(`--runtime-env "DEPLOYMENT_ENVIRONMENT=${environment}"`);
    }

    expect(stagingPublish).toContain("uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(stagingPublish).toContain(
      "name: managed-postgres-ca-staging-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(stagingPublish).toContain("if-no-files-found: error");
    expect(stagingJob.indexOf(stagingReceipt)).toBeLessThan(stagingJob.indexOf(stagingPublish));

    const helmOnlyScope = classifyChanges({
      changedFiles: ["infrastructure/helm/platform/templates/deployment.yaml"],
      workspaces: [],
    });
    const docsOnlyScope = classifyChanges({
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md"],
      workspaces: [],
    });
    expect(dayAfterManagedPostgresCaJobsAreEligible(platformProductionWorkflow, helmOnlyScope)).toBe(false);
    expect(dayAfterManagedPostgresCaJobsAreEligible(platformProductionWorkflow, docsOnlyScope)).toBe(true);
    expect(platformKubernetesDeploymentScript).toContain('"--reuse-values"');
    expect(platformKubernetesDeploymentScript).toContain('"--no-hooks"');
  });

  it("captures staging wake drill worker status through the internal DOKS worker endpoint", () => {
    const wakeDrillJob = workflowJob(platformStagingWakeDrillsWorkflow, "staging-wake-drill");
    const kubeconfigStep = workflowStep(wakeDrillJob, "Configure staging Kubernetes context");
    const portForwardStep = workflowStep(wakeDrillJob, "Start staging worker-status port-forward");
    const runDrillStep = workflowStep(wakeDrillJob, "Run staging wake drill");

    expect(wakeDrillJob).toContain("CHASE_SETS_KUBERNETES_NAMESPACE: chase-sets-platform");
    expect(wakeDrillJob).toContain("digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f");
    expect(wakeDrillJob).toContain("token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");

    expect(kubeconfigStep).toContain("infrastructure/digitalocean/doks");
    expect(kubeconfigStep).toContain("-backend-config=key=doks/staging.tfstate");
    expect(kubeconfigStep).toContain("terraform output -raw kubeconfig");
    expect(kubeconfigStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(kubeconfigStep).toContain("Terraform DOKS kubeconfig output did not contain a usable current-context");
    expect(kubeconfigStep).toContain('doctl kubernetes cluster kubeconfig show "$cluster_id"');
    expect(kubeconfigStep).toContain('doctl kubernetes cluster kubeconfig show "$cluster_name"');
    expect(kubeconfigStep).toContain("KUBECONFIG=");

    expect(portForwardStep).toContain("app.kubernetes.io/component=platform-worker");
    expect(portForwardStep).toContain("app.kubernetes.io/instance=chase-sets-platform");
    expect(portForwardStep).toContain("kubectl port-forward");
    expect(portForwardStep).toContain('"deployment/${worker_deployment}"');
    expect(portForwardStep).toContain(
      '--output jsonpath=\'{.spec.template.spec.containers[?(@.name=="platform-worker")].ports[?(@.name=="http")].containerPort}\'',
    );
    expect(portForwardStep).toContain(
      "Could not resolve staging platform-worker http container port from deployment/${worker_deployment}.",
    );
    expect(portForwardStep).toContain('"${worker_status_port}:${worker_target_port}"');
    expect(portForwardStep).not.toContain("worker_target_port=6183");
    expect(portForwardStep).toContain(
      "WAKE_DRILL_WORKER_STATUS_URL=http://127.0.0.1:${worker_status_port}/internal/workers/status",
    );
    expect(portForwardStep).toContain("Staging worker-status port-forward is ready.");

    expect(runDrillStep).not.toContain("STAGING_PLATFORM_WORKER_STATUS_URL");
    expect(runDrillStep).not.toContain("WAKE_DRILL_WORKER_STATUS_URL:");
  });

  it("provisions databases for every platform-api bounded context", () => {
    const managedContexts = terraformStringList(platformLocals, "platform_context_names");
    expect(managedContexts).toEqual(expect.arrayContaining(platformApiContextNames()));
  });

  it("separates provisioned database contexts from active runtime and route exposure", () => {
    const landingContexts = terraformStringList(platformLocals, "landing_context_names");
    const landingExposedRouteContexts = terraformStringList(platformLocals, "landing_exposed_route_context_names");
    const platformContexts = terraformStringList(platformLocals, "platform_context_names");

    expect(landingContexts.filter((contextName) => contextName !== "control").sort()).toEqual(
      platformApiRuntimeContextNames("landing"),
    );
    expect(landingExposedRouteContexts.sort()).toEqual(platformApiExposedContextNames("landing"));
    expect(landingContexts).not.toContain("checkout");
    expect(landingContexts).not.toContain("payments");
    expect(landingContexts).toEqual(expect.arrayContaining(["commercial-terms", "settlement"]));
    expect(landingExposedRouteContexts).not.toContain("commercial-terms");
    expect(landingExposedRouteContexts).not.toContain("settlement");
    expect(platformContexts).toEqual(expect.arrayContaining(["checkout", "payments", "settlement"]));
    expect(platformLocals).toContain(
      "active_runtime_context_names = local.platform_enabled ? local.platform_context_names : local.landing_context_names",
    );
    expect(platformLocals).toContain(
      "exposed_route_context_names  = local.platform_enabled ? local.platform_context_names : local.landing_exposed_route_context_names",
    );
    expect(platformLocals).toContain("context_names = local.active_runtime_context_names");
    expect(platformLocals).toContain(
      "provisioned_context_names = local.is_production ? local.production_provisioned_context_names : local.active_runtime_context_names",
    );
    expect(platformLocals).toContain("context_database_names = local.provisioned_context_names");
  });

  it("pre-provisions production context databases even when public marketplace exposure is gated", () => {
    const activeContexts = terraformStringList(platformLocals, "platform_context_names");
    const additionalProvisionedContexts = terraformStringList(
      platformLocals,
      "production_additional_provisioned_context_names",
    );

    expect(activeContexts).not.toContain("reputation");
    expect(additionalProvisionedContexts).toEqual(["reputation"]);
    expect(platformLocals).toContain("production_provisioned_context_names = distinct(concat(");
    expect(platformLocals).toContain("local.platform_context_names");
    expect(platformLocals).toContain("local.production_additional_provisioned_context_names");
    // Provisioning locals (name tokens, databases, users) iterate the full
    // provisioned set. #4655 moved context_database_urls to iterate the active
    // local.context_names (only active contexts get a query pool), and the
    // per-preview in-cluster Postgres change (#4656) adds one provisioned-set
    // comprehension for the synthesized preview URLs, so the provisioned-set
    // iteration count is 4. Production provisioning semantics are unchanged.
    expect(occurrenceCount(platformLocals, "for context_name in local.context_database_names :")).toBe(4);
  });

  it("keeps production context database names within DigitalOcean limits", () => {
    const managedContexts = [
      ...terraformStringList(platformLocals, "platform_context_names"),
      ...terraformStringList(platformLocals, "production_additional_provisioned_context_names"),
    ];
    const databaseNameOverrides = terraformStringMap(platformLocals, "context_database_name_token_overrides");
    const databaseNames = managedContexts.map((contextName) => {
      const token = databaseNameOverrides[contextName] ?? contextName.replaceAll("-", "_");
      return `chase_sets_production_${token}`;
    });

    expect(platformMain).toContain('check "context_database_name_lengths"');
    expect(databaseNames.filter((databaseName) => databaseName.length > 40)).toEqual([]);
    expect(databaseNames).toContain("chase_sets_production_platform_ops");
  });

  it("guards scheduled registry cleanup against queued or active platform deploys", () => {
    const deployLaneStep = workflowStep(platformRegistryCleanupWorkflow, "Check deploy lane");
    const cleanupStep = workflowStep(platformRegistryCleanupWorkflow, "Cleanup registry tags");
    const validateStep = workflowStep(platformRegistryCleanupWorkflow, "Validate canonical registry cleanup record");
    const uploadStep = workflowStep(platformRegistryCleanupWorkflow, "Upload registry cleanup artifact");

    expect(platformRegistryCleanupWorkflow).toContain("actions: read");
    expect(platformRegistryCleanupWorkflow).toContain("group: platform-registry-mutation");
    expect(platformProductionWorkflow).toContain("|| 'platform-registry-mutation' }}");
    expect(platformStagingResetWorkflow).toContain("group: platform-registry-mutation");
    expect(platformStagingResetWorkflow).toContain("group: platform-deploy-staging");
    expect(platformRegistryCleanupWorkflow).toContain("DOCR garbage collection makes the registry read-only");
    expect(platformProductionWorkflow).toContain(
      'docker buildx imagetools create --tag "$release_image" "${promoted_image}@${promoted_digest}"',
    );
    expect(platformStagingResetWorkflow).toContain("Staging reset rebuilds and pushes the platform image");
    expect(deployLaneStep).toContain('const workflows = ["platform-production.yml", "platform-staging-reset.yml"];');
    expect(deployLaneStep).toContain('const statuses = ["queued", "in_progress", "waiting", "requested", "pending"];');
    expect(deployLaneStep).toContain('reason: "deploy-lane-active"');
    expect(deployLaneStep).toContain('result: "deferred"');
    expect(cleanupStep).toContain("if: steps.deploy_lane.outputs.deferred != 'true'");
    expect(cleanupStep).toContain("--retain-recent-sha-tree-tags=25");
    expect(platformRegistryCleanupWorkflow).toContain(
      "DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN: ${{ github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run }}",
    );
    expect(cleanupStep).toContain('--dry-run="${DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN}"');
    expect(cleanupStep).toContain("--out artifacts/release-health/digitalocean-registry-cleanup.json");
    expect(cleanupStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_REGISTRY_TOKEN }}");
    expect(validateStep).toContain("if: ${{ always() }}");
    expect(validateStep).toContain(
      "digitalocean-registry-cleanup-record.mjs --record=artifacts/release-health/digitalocean-registry-cleanup.json",
    );
    expect(uploadStep).toContain("path: artifacts/release-health/digitalocean-registry-cleanup.json");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).not.toContain("if-no-files-found: ignore");
    expect(cleanupStep).not.toContain("dry_run_arg");
    expect(cleanupStep).not.toContain("--retention-days=7");
    expect(digitaloceanPlatformRunbook).toContain(
      "Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup share the `platform-registry-mutation` GitHub Actions concurrency group",
    );
  });

  it("captures sensitive Terraform errored state artifacts when platform apply fails", () => {
    const stagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const stagingDnsApplyStep = workflowStep(stagingJob, "Terraform apply staging environment DNS");
    const stagingPlanStep = workflowStep(stagingJob, "Terraform plan");
    const stagingApplyStep = workflowSteps(stagingJob, "Terraform apply").at(-1);
    const productionPlanStep = workflowStep(productionJob, "Terraform plan");
    const productionApplyStep = workflowSteps(productionJob, "Terraform apply").at(-1);
    const stagingClassificationStep = workflowStep(stagingJob, "Classify staging deployment failure");
    const productionClassificationStep = workflowStep(productionJob, "Classify production deployment failure");
    const stagingCaptureStep = workflowStep(platformProductionWorkflow, "Capture staging Terraform errored state");
    const stagingUploadStep = workflowStep(platformProductionWorkflow, "Upload staging Terraform errored state");
    const productionCaptureStep = workflowStep(
      platformProductionWorkflow,
      "Capture production Terraform errored state",
    );
    const productionUploadStep = workflowStep(platformProductionWorkflow, "Upload production Terraform errored state");

    const stagingCaptureIndex = platformProductionWorkflow.indexOf("- name: Capture staging Terraform errored state");
    const stagingUploadIndex = platformProductionWorkflow.indexOf("- name: Upload staging Terraform errored state");
    const stagingApplyIndex = platformProductionWorkflow.lastIndexOf("- name: Terraform apply", stagingCaptureIndex);

    const productionCaptureIndex = platformProductionWorkflow.indexOf(
      "- name: Capture production Terraform errored state",
    );
    const productionUploadIndex = platformProductionWorkflow.indexOf(
      "- name: Upload production Terraform errored state",
    );
    const productionApplyIndex = platformProductionWorkflow.lastIndexOf(
      "- name: Terraform apply",
      productionCaptureIndex,
    );
    const productionDiagnosticsIndex = platformProductionWorkflow.indexOf(
      "- name: Capture production Kubernetes deploy diagnostics",
      productionUploadIndex,
    );

    expect(stagingApplyIndex).toBeGreaterThan(-1);
    expect(stagingCaptureIndex).toBeGreaterThan(stagingApplyIndex);
    expect(stagingUploadIndex).toBeGreaterThan(stagingCaptureIndex);
    expect(productionApplyIndex).toBeGreaterThan(-1);
    expect(productionCaptureIndex).toBeGreaterThan(productionApplyIndex);
    expect(productionUploadIndex).toBeGreaterThan(productionCaptureIndex);
    expect(productionDiagnosticsIndex).toBeGreaterThan(productionUploadIndex);

    expect(stagingDnsApplyStep).toContain(
      '2> >(tee "${GITHUB_WORKSPACE}/artifacts/release-health/staging-terraform-diagnostics.txt" >&2)',
    );
    expect(stagingPlanStep).toContain(
      '2> >(tee "${GITHUB_WORKSPACE}/artifacts/release-health/staging-terraform-diagnostics.txt" >&2)',
    );
    expect(stagingApplyStep).toContain(
      '2> >(tee "${GITHUB_WORKSPACE}/artifacts/release-health/staging-terraform-diagnostics.txt" >&2)',
    );
    expect(stagingClassificationStep).toContain("artifacts/release-health/staging-terraform-diagnostics.txt");
    expect(productionPlanStep).toContain(
      '2> >(tee "${GITHUB_WORKSPACE}/artifacts/release-health/production-terraform-diagnostics.txt" >&2)',
    );
    expect(productionApplyStep).toContain(
      '2> >(tee "${GITHUB_WORKSPACE}/artifacts/release-health/production-terraform-diagnostics.txt" >&2)',
    );
    expect(productionClassificationStep).toContain("artifacts/release-health/production-terraform-diagnostics.txt");
    expect(productionClassificationStep).toContain("--phase production-deploy");
    expect(productionClassificationStep).not.toContain("--phase production-verification");

    expect(stagingCaptureStep).toContain("if: failure() && env.SHOULD_DEPLOY != 'false'");
    expect(stagingCaptureStep).toContain("id: capture_staging_terraform_errored_state");
    expect(stagingCaptureStep).toContain('state_path="errored.tfstate"');
    expect(stagingCaptureStep).toContain('artifact_path="artifacts/terraform-errored-state/staging-errored.tfstate"');
    expect(stagingCaptureStep).toContain("Do not print or share its contents.");
    expect(stagingUploadStep).toContain(
      "if: failure() && env.SHOULD_DEPLOY != 'false' && steps.capture_staging_terraform_errored_state.outputs.captured == 'true'",
    );
    expect(stagingUploadStep).toContain("name: sensitive-staging-terraform-errored-state-recovery-only");
    expect(stagingUploadStep).toContain(
      "path: infrastructure/digitalocean/platform/artifacts/terraform-errored-state/staging-errored.tfstate",
    );
    expect(stagingUploadStep).toContain("retention-days: 1");

    expect(productionCaptureStep).toContain("if: failure() && env.SHOULD_DEPLOY != 'false'");
    expect(productionCaptureStep).toContain("id: capture_production_terraform_errored_state");
    expect(productionCaptureStep).toContain('state_path="errored.tfstate"');
    expect(productionCaptureStep).toContain(
      'artifact_path="artifacts/terraform-errored-state/production-errored.tfstate"',
    );
    expect(productionCaptureStep).toContain("Do not print or share its contents.");
    expect(productionUploadStep).toContain(
      "if: failure() && env.SHOULD_DEPLOY != 'false' && steps.capture_production_terraform_errored_state.outputs.captured == 'true'",
    );
    expect(productionUploadStep).toContain("name: sensitive-production-terraform-errored-state-recovery-only");
    expect(productionUploadStep).toContain(
      "path: infrastructure/digitalocean/platform/artifacts/terraform-errored-state/production-errored.tfstate",
    );
    expect(productionUploadStep).toContain("retention-days: 1");
  });

  it("fails closed when Terraform state snapshot evidence artifact is missing", () => {
    const snapshotStep = workflowStep(platformTerraformStateSnapshotWorkflow, "Snapshot Terraform state");
    const uploadStep = workflowStep(platformTerraformStateSnapshotWorkflow, "Upload Terraform state snapshot artifact");

    expect(snapshotStep).toContain("--out=artifacts/release-health/digitalocean-terraform-state-snapshot.json");
    expect(snapshotStep).not.toContain("--out artifacts/release-health/digitalocean-terraform-state-snapshot.json");
    expect(uploadStep).toContain("path: artifacts/release-health/digitalocean-terraform-state-snapshot.json");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).not.toContain("if-no-files-found: ignore");
  });

  it("keeps admin-web API dependency inventory aligned with local proxy coverage", () => {
    const localProxyPrefixes = viteProxyPrefixes();

    expect(ADMIN_WEB_API_DEPENDENCIES.map((dependency) => dependency.callerType)).toEqual(
      expect.arrayContaining(["server-loader/action", "direct-download", "event-source", "durable-job-event-source"]),
    );

    const missingIds = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !dependency.id || !dependency.smokeCoverageId,
    ).map((dependency) => dependency.surface);
    expect(missingIds).toEqual([]);

    const missingTopologyModes = ADMIN_WEB_API_DEPENDENCIES.filter((dependency) =>
      ["staging", "public-marketplace", "production-platform-disabled"].some(
        (mode) => !dependency.topologyExpectations?.[mode],
      ),
    ).map((dependency) => dependency.id);
    expect(missingTopologyModes).toEqual([]);

    const missingSourceFiles = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !existsSync(resolve(dependency.sourceFile)),
    ).map((dependency) => `${dependency.surface}: ${dependency.sourceFile}`);
    expect(missingSourceFiles).toEqual([]);

    const missingSourceEvidence = ADMIN_WEB_API_DEPENDENCIES.filter((dependency) => {
      const source = readFileSync(resolve(dependency.sourceFile), "utf8");
      return dependency.sourceEvidence.some((needle) => !source.includes(needle));
    }).map(
      (dependency) =>
        `${dependency.surface} (${dependency.callerType}) is missing source evidence for ${dependency.apiPath}`,
    );
    expect(missingSourceEvidence).toEqual([]);

    const missingProxy = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !pathCoveredByPrefix(dependency.apiPath, dependency.localProxyPrefix),
    ).map(
      (dependency) => `${dependency.surface}: ${dependency.apiPath} is not covered by ${dependency.localProxyPrefix}`,
    );
    expect(missingProxy).toEqual([]);

    const missingConfiguredProxy = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !localProxyPrefixes.includes(dependency.localProxyPrefix),
    ).map((dependency) => `${dependency.surface}: ${dependency.localProxyPrefix}`);
    expect(missingConfiguredProxy).toEqual([]);

    expect(ADMIN_WEB_API_DEPENDENCIES.filter((dependency) => dependency.proofAdminIngressPrefix)).toEqual([]);
  });

  it("adds Shipit-like PR release status without replacing merge queue", () => {
    expect(platformPrWorkflow).toContain("pull-requests: write");
    expect(platformPrWorkflow).toContain("release-status:");
    expect(platformPrWorkflow).toContain("name: PR Release Status");
    expect(platformPrWorkflow).toContain("PR_REQUIRED_RESULT: ${{ needs['pr-required'].result }}");
    expect(platformPrWorkflow).toContain("DEPLOYMENT_REQUIRED: ${{ needs['change-scope'].outputs.deploy }}");
    expect(platformPrWorkflow).toContain("node ./scripts/pr-release-status.mjs");
    expect(platformPrWorkflow).toContain('cat artifacts/pr-release-status.md >> "$GITHUB_STEP_SUMMARY"');
    expect(platformPrWorkflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(platformPrWorkflow).toContain(
      'gh api --method POST "repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/comments"',
    );
  });

  it("passes changed files into static checks for PR-scoped structure guards", () => {
    const staticStep = workflowStep(platformPrWorkflow, "Run static checks");

    expect(platformPrWorkflow).toContain("changed_files_json: ${{ steps.scope.outputs.changed_files_json }}");
    expect(staticStep).toContain("CHANGED_FILES_JSON: ${{ needs.change-scope.outputs.changed_files_json }}");
    expect(staticStep).toContain("FORMAT_CHECK_SCOPE: full");
    expect(staticStep).toContain("pnpm run verify:static");
  });

  it("keeps PR fast-lane checks separate from merge-group full battery", () => {
    const fullBatteryStep = workflowStep(platformPrWorkflow, "Resolve full battery lane");
    const dbProfileJob = workflowJob(platformPrWorkflow, "db-tests");
    const e2eJob = workflowJob(platformPrWorkflow, "e2e-tests");
    const buildJob = workflowJob(platformPrWorkflow, "build");
    const dockerJob = workflowJob(platformPrWorkflow, "docker-image");
    const terraformPreviewJob = workflowJob(platformPrWorkflow, "terraform-preview-plan");
    const terraformStagingJob = workflowJob(platformPrWorkflow, "terraform-staging-plan");
    const terraformProductionJob = workflowJob(platformPrWorkflow, "terraform-production-plan");
    const terraformObservabilityJob = workflowJob(platformPrWorkflow, "terraform-observability-plan");
    const requiredJob = workflowJob(platformPrWorkflow, "pr-required");

    expect(platformPrWorkflow).toContain("full_battery_required: ${{ steps.full-battery.outputs.required }}");
    expect(platformPrWorkflow).toContain(
      "integration_risk_required: ${{ steps.scope.outputs.integration_risk_required }}",
    );
    expect(platformPrWorkflow).toContain("integration_risk_reason: ${{ steps.scope.outputs.integration_risk_reason }}");
    expect(platformPrWorkflow).toContain(
      "targeted_heavy_required: ${{ steps.full-battery.outputs.targeted_required }}",
    );
    expect(fullBatteryStep).toContain('"${{ github.event_name }}" = "merge_group"');
    expect(fullBatteryStep).toContain("contains(github.event.pull_request.labels.*.name, 'full-ci')");
    expect(fullBatteryStep).toContain("contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(fullBatteryStep).toContain(
      "INTEGRATION_RISK_REQUIRED: ${{ steps.scope.outputs.integration_risk_required }}",
    );
    expect(fullBatteryStep).toContain('targeted_reason="integration-risk: $INTEGRATION_RISK_REASON"');

    for (const job of [buildJob, dockerJob, terraformPreviewJob, terraformStagingJob, terraformProductionJob]) {
      expect(job).toContain("needs['change-scope'].outputs.full_battery_required == 'true'");
    }

    expect(workflowJobCondition(platformPrWorkflow, "db-tests")).toBe(
      "needs['change-scope'].outputs.db_tests == 'true'",
    );
    expect(dbProfileJob).not.toContain("needs['change-scope'].outputs.full_battery_required == 'true'");
    expect(dbProfileJob).not.toContain("needs['change-scope'].outputs.integration_risk_required == 'true'");
    expect(workflowJobCondition(platformPrWorkflow, "e2e-tests")).toBe(
      "(needs['change-scope'].outputs.full_battery_required == 'true' || needs['change-scope'].outputs.integration_risk_required == 'true') && needs['change-scope'].outputs.e2e_tests == 'true'",
    );

    expect(terraformObservabilityJob).toContain("if: needs['change-scope'].outputs.terraform == 'true'");
    expect(terraformObservabilityJob).not.toContain("needs['change-scope'].outputs.full_battery_required == 'true'");
    expect(terraformObservabilityJob).toContain("Terraform plan shared observability");
    expect(terraformObservabilityJob).toContain('plan_root="${RUNNER_TEMP}/chase-sets-observability-plan"');
    expect(terraformObservabilityJob).toContain("backend_block = '\\n  backend \"s3\" {}\\n'");
    expect(terraformObservabilityJob).toContain("Expected observability backend block was not found.");
    expect(terraformObservabilityJob).toContain("versions.replace(backend_block, '\\n')");
    expect(terraformObservabilityJob).toContain(
      'terraform -chdir="${plan_root}/infrastructure/digitalocean/observability" init -backend=false',
    );
    expect(terraformObservabilityJob).toContain(
      'plan_artifact="infrastructure/digitalocean/observability/artifacts/terraform-plans/observability-shared-tfplan.txt"',
    );
    expect(terraformObservabilityJob).toContain("observability-shared-tfplan.txt");
    expect(terraformObservabilityJob).toContain("name: observability-shared-terraform-plan");
    expect(terraformProductionJob).toContain('cd "$tmp"');
    expect(terraformProductionJob).toContain(
      'node "$GITHUB_WORKSPACE/scripts/terraform-plan-inspection.mjs" assert-no-destructive-changes tfplan',
    );

    expect(requiredJob).toContain(
      "full_battery_required=\"${{ needs['change-scope'].outputs.full_battery_required }}\"",
    );
    expect(requiredJob).toContain(
      "targeted_heavy_required=\"${{ needs['change-scope'].outputs.targeted_heavy_required }}\"",
    );
    expect(requiredJob).toContain('require_job "DB Profile Tests"');
    expect(requiredJob).not.toContain('require_targeted_heavy_job "DB Profile Tests"');
    expect(requiredJob).toContain('require_targeted_heavy_job "E2E Tests"');
    expect(requiredJob).toContain('require_heavy_job "Build"');
    expect(requiredJob).toContain('require_heavy_job "Docker Image Build"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Preview Plan"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Staging Plan"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Production Plan"');
    expect(requiredJob).toContain('require_job "Terraform Observability Plan"');
    expect(requiredJob).toContain('require_job "Workflow Lint"');
  });

  it("derives isolated DB admission and unchanged E2E admission from the workflow text", () => {
    const dbCondition = workflowJobCondition(platformPrWorkflow, "db-tests");
    const e2eCondition = workflowJobCondition(platformPrWorkflow, "e2e-tests");
    const overlapValues = {
      "needs['change-scope'].outputs.full_battery_required": "false",
      "needs['change-scope'].outputs.integration_risk_required": "false",
      "needs['change-scope'].outputs.db_tests": "true",
      "needs['change-scope'].outputs.e2e_tests": "true",
    };

    expect(evaluateWorkflowBooleanExpression(dbCondition, overlapValues)).toBe(true);
    expect(evaluateWorkflowBooleanExpression(e2eCondition, overlapValues)).toBe(false);
    expect(dbCondition).toBe("needs['change-scope'].outputs.db_tests == 'true'");
    expect(e2eCondition).toBe(
      "(needs['change-scope'].outputs.full_battery_required == 'true' || needs['change-scope'].outputs.integration_risk_required == 'true') && needs['change-scope'].outputs.e2e_tests == 'true'",
    );

    const dbProfileJob = workflowJob(platformPrWorkflow, "db-tests");
    expect(dbProfileJob).toContain("timeout-minutes: 20");
    expect(dbProfileJob).toContain("image: pgvector/pgvector:pg16");
    expect(dbProfileJob).toContain("TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres");
    expect(dbProfileJob).toContain("target_max_locks_per_transaction=512");
    expect(dbProfileJob).toContain(
      'run: node ./scripts/run-workspaces.mjs "test:db*" --concurrency=2 --workspace-list="${{ needs[\'change-scope\'].outputs.affected_workspaces }}"',
    );
    expect(readFileSync(resolve("package.json"), "utf8")).toContain(
      '"verify:test-db": "node ./scripts/db-test-preflight.mjs && node ./scripts/run-workspaces.mjs \\"test:db*\\" --concurrency=2"',
    );
  });

  it("evaluates the preview DB prerequisite truth table and retained-bypass mutant from workflow text", () => {
    const previewCondition = workflowJobCondition(platformPrWorkflow, "preview-deploy-smoke");
    const dbPrerequisite = workflowPrerequisite(previewCondition, "db_tests", "db-tests");
    const e2ePrerequisite = workflowPrerequisite(previewCondition, "e2e_tests", "e2e-tests");
    const expectedPreviewCondition = `
      always() &&
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      needs['change-scope'].result == 'success' &&
      (needs['change-scope'].outputs.cluster_preview == 'true' ||
       contains(github.event.pull_request.labels.*.name, 'preview')) &&
      (needs['change-scope'].outputs.local_checks != 'true' || needs.static.result == 'success') &&
      needs.typecheck.result == 'success' &&
      (needs['change-scope'].outputs.unit_tests != 'true' || needs['unit-tests'].result == 'success') &&
      (needs['change-scope'].outputs.db_tests != 'true' || needs['db-tests'].result == 'success') &&
      (needs['change-scope'].outputs.full_battery_required != 'true' ||
       needs['change-scope'].outputs.e2e_tests != 'true' ||
       needs['e2e-tests'].result == 'success') &&
      (needs['change-scope'].outputs.full_battery_required != 'true' ||
       needs['change-scope'].outputs.build != 'true' ||
       needs.build.result == 'success') &&
      (needs['change-scope'].outputs.full_battery_required != 'true' ||
       needs['change-scope'].outputs.docker_image != 'true' ||
       needs['docker-image'].result == 'success') &&
      (needs['change-scope'].outputs.workflow_lint != 'true' || needs['workflow-lint'].result == 'success') &&
      (needs['change-scope'].outputs.full_battery_required != 'true' ||
       needs['change-scope'].outputs.terraform != 'true' ||
       (needs['terraform-preview-plan'].result == 'success' &&
        needs['terraform-staging-plan'].result == 'success' &&
        needs['terraform-production-plan'].result == 'success'))
    `
      .replace(/\s+/g, " ")
      .trim();

    expect(previewCondition.replace(/\s+/g, " ").trim()).toBe(expectedPreviewCondition);
    expect(dbPrerequisite).toBe(
      "(needs['change-scope'].outputs.db_tests != 'true' || needs['db-tests'].result == 'success')",
    );
    expect(e2ePrerequisite).toBe(
      "(needs['change-scope'].outputs.full_battery_required != 'true' || needs['change-scope'].outputs.e2e_tests != 'true' || needs['e2e-tests'].result == 'success')",
    );

    const results = ["failure", "skipped", "cancelled", "success"];
    const truthTable = [];
    for (const dbTests of ["true", "false"]) {
      for (const result of results) {
        const admitted = evaluateWorkflowBooleanExpression(dbPrerequisite, {
          "needs['change-scope'].outputs.db_tests": dbTests,
          "needs['db-tests'].result": result,
        });
        truthTable.push({ dbTests, result, admitted });
        expect(admitted).toBe(dbTests === "true" ? result === "success" : true);
      }
    }

    const retainedBypassMutant =
      "(needs['change-scope'].outputs.full_battery_required != 'true' || needs['change-scope'].outputs.db_tests != 'true' || needs['db-tests'].result == 'success')";
    const retainedBypassMutantAdmitsFailure = evaluateWorkflowBooleanExpression(retainedBypassMutant, {
      "needs['change-scope'].outputs.full_battery_required": "false",
      "needs['change-scope'].outputs.db_tests": "true",
      "needs['db-tests'].result": "failure",
    });
    expect(retainedBypassMutantAdmitsFailure).toBe(true);
    expect(
      evaluateWorkflowBooleanExpression(dbPrerequisite, {
        "needs['change-scope'].outputs.db_tests": "true",
        "needs['db-tests'].result": "failure",
      }),
    ).toBe(false);
    console.info("hosted-db preview truth table", truthTable);
    console.info("hosted-db retained-preview-bypass mutant", { retainedBypassMutantAdmitsFailure });
  });

  it("evaluates DB aggregation truth tables and the retained-targeted-lane mutant from gate shell text", () => {
    const requiredJob = workflowJob(platformPrWorkflow, "pr-required");
    const dbCall = workflowRequiredCall(requiredJob, "DB Profile Tests");
    const e2eCall = workflowRequiredCall(requiredJob, "E2E Tests");
    const requireJobFunction = workflowShellFunction(requiredJob, "require_job");
    const targetedHelper = workflowShellFunction(requiredJob, "require_targeted_heavy_job");

    expect(dbCall.line).toBe(
      'require_job "DB Profile Tests" "${{ needs[\'db-tests\'].result }}" "${{ needs[\'change-scope\'].outputs.db_tests }}"',
    );
    expect(e2eCall.line).toBe(
      'require_targeted_heavy_job "E2E Tests" "${{ needs[\'e2e-tests\'].result }}" "${{ needs[\'change-scope\'].outputs.e2e_tests }}"',
    );
    expect(requireJobFunction).toBe(`          require_job() {
            local name="$1"
            local result="$2"
            local required="$3"

            if [ "$required" = "true" ]; then
              if [ "$result" != "success" ]; then
                echo "\${name} was required but finished with result '\${result}'." >&2
                exit 1
              fi
              return
            fi

            if [ "$result" != "skipped" ] && [ "$result" != "success" ]; then
              echo "\${name} was not required but finished with unexpected result '\${result}'." >&2
              exit 1
            fi
          }`);
    expect(targetedHelper).toBe(`          require_targeted_heavy_job() {
            local name="$1"
            local result="$2"
            local affected="$3"

            if [ "$targeted_heavy_required" = "true" ] && [ "$affected" = "true" ]; then
              require_job "$name" "$result" "true"
              return
            fi

            require_job "$name" "$result" "false"
          }`);

    const expectedRequiredCalls = [
      'require_job "Known Failure Guard" "${{ needs[\'known-failure-guard\'].result }}" "true"',
      'require_job "Change Scope" "${{ needs[\'change-scope\'].result }}" "true"',
      'require_job "Static Checks" "${{ needs.static.result }}" "${{ needs[\'change-scope\'].outputs.local_checks }}"',
      'require_job "Typecheck" "${{ needs.typecheck.result }}" "true"',
      'require_job "Unit Tests" "${{ needs[\'unit-tests\'].result }}" "${{ needs[\'change-scope\'].outputs.unit_tests }}"',
      'require_job "Workflow Lint" "${{ needs[\'workflow-lint\'].result }}" "${{ needs[\'change-scope\'].outputs.workflow_lint }}"',
      dbCall.line,
      e2eCall.line,
      'require_heavy_job "Build" "${{ needs.build.result }}" "${{ needs[\'change-scope\'].outputs.build }}"',
      'require_heavy_job "Docker Image Build" "${{ needs[\'docker-image\'].result }}" "${{ needs[\'change-scope\'].outputs.docker_image }}"',
      'require_heavy_job "Terraform Preview Plan" "${{ needs[\'terraform-preview-plan\'].result }}" "${{ needs[\'change-scope\'].outputs.terraform }}"',
      'require_heavy_job "Terraform Staging Plan" "${{ needs[\'terraform-staging-plan\'].result }}" "${{ needs[\'change-scope\'].outputs.terraform }}"',
      'require_heavy_job "Terraform Production Plan" "${{ needs[\'terraform-production-plan\'].result }}" "${{ needs[\'change-scope\'].outputs.terraform }}"',
      'require_job "Terraform Observability Plan" "${{ needs[\'terraform-observability-plan\'].result }}" "${{ needs[\'change-scope\'].outputs.terraform }}"',
    ];
    const actualRequiredCalls = requiredJob
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^require(?:_targeted_heavy|_heavy)?_job "[A-Z]/.test(line));
    expect(actualRequiredCalls).toEqual(expectedRequiredCalls);

    const truthTable = [];
    for (const dbTests of ["true", "false"]) {
      for (const result of ["failure", "skipped", "cancelled", "success"]) {
        const admitted = evaluateRequiredWorkflowCall(dbCall, {
          targetedHeavyRequired: false,
          templateValues: {
            "needs['db-tests'].result": result,
            "needs['change-scope'].outputs.db_tests": dbTests,
          },
        });
        truthTable.push({ dbTests, result, admitted });
        expect(admitted).toBe(dbTests === "true" ? result === "success" : result === "skipped" || result === "success");
      }
    }

    const retainedTargetedMutant = { ...dbCall, helper: "require_targeted_heavy_job" };
    const mutantAdmitsFastLaneSkip = evaluateRequiredWorkflowCall(retainedTargetedMutant, {
      targetedHeavyRequired: false,
      templateValues: {
        "needs['db-tests'].result": "skipped",
        "needs['change-scope'].outputs.db_tests": "true",
      },
    });
    expect(mutantAdmitsFastLaneSkip).toBe(true);
    expect(
      evaluateRequiredWorkflowCall(dbCall, {
        targetedHeavyRequired: false,
        templateValues: {
          "needs['db-tests'].result": "skipped",
          "needs['change-scope'].outputs.db_tests": "true",
        },
      }),
    ).toBe(false);
    console.info("hosted-db PR Required aggregation truth table", truthTable);
    console.info("hosted-db retained-targeted-lane mutant", { mutantAdmitsFastLaneSkip });
  });

  it("requires preview deploy and smoke for deploy-scoped same-repository PRs without blocking forks", () => {
    const previewJob = workflowJob(platformPrWorkflow, "preview-deploy-smoke");
    const requiredJob = workflowJob(platformPrWorkflow, "pr-required");
    const runtimeSecretsStep = workflowStep(previewJob, "Apply preview Kubernetes runtime secrets");

    expect(previewJob).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(previewJob).toContain("needs['change-scope'].result == 'success'");
    expect(previewJob).toContain("needs['change-scope'].outputs.cluster_preview == 'true'");
    expect(previewJob).toContain("contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(previewJob).toContain("needs['change-scope'].outputs.e2e_tests != 'true'");
    expect(previewJob).toContain("needs['e2e-tests'].result == 'success'");
    expect(previewJob).toContain("needs['change-scope'].outputs.full_battery_required != 'true'");
    expect(previewJob).toContain("id: preview_domains");
    expect(previewJob).toContain('echo "landing_domain_ready=${landing_domain_ready}"');
    expect(previewJob).toContain('} >> "$GITHUB_OUTPUT"');
    // Landing-only smoke is gated on landing-domain readiness through
    // SMOKE_REQUIRE_LANDING rather than a shell skip message: the smoke runner
    // is told not to require landing when its ingress is not yet reachable.
    expect(previewJob).toContain(
      "SMOKE_REQUIRE_LANDING: ${{ steps.preview_domains.outputs.landing_domain_ready == 'true' && 'true' || 'false' }}",
    );
    expect(previewJob).toContain('"https://${{ steps.preview_domains.outputs.landing_domain }}"');
    expect(previewJob).toContain("pnpm run smoke:platform --");

    // Optional provider endpoints must never be passed as empty --runtime-env
    // overrides: the deploy script fails closed on empty values, and the Helm
    // chart's preview env defaults already carry the retired runtime
    // preview posture when a repository variable is unset.
    expect(previewJob).toContain('add_optional_runtime_env "STRIPE_API_BASE_URL" "${TF_VAR_stripe_api_base_url:-}"');
    expect(previewJob).toContain(
      'add_optional_runtime_env "EASYPOST_API_BASE_URL" "${TF_VAR_easypost_api_base_url:-}"',
    );
    expect(previewJob).toContain('add_optional_runtime_env "SES_AWS_REGION" "${TF_VAR_ses_aws_region:-}"');
    expect(previewJob).toContain('add_optional_runtime_env "SES_FROM_EMAIL" "${TF_VAR_ses_from_email:-}"');
    expect(previewJob).toContain(
      'add_optional_runtime_env "SES_CONFIGURATION_SET_NAME" "${TF_VAR_ses_configuration_set_name:-}"',
    );
    expect(previewJob).not.toContain('--runtime-env "STRIPE_API_BASE_URL=');
    expect(previewJob).not.toContain('--runtime-env "EASYPOST_API_BASE_URL=');
    expect(previewJob).not.toContain('--runtime-env "SES_');

    const ucpSecretEnvironmentNames = [
      ["UCP_BUSINESS_SIGNING_KEY_ID", "ucp_business_signing_key_id"],
      ["UCP_BUSINESS_SIGNING_ALG", "ucp_business_signing_alg"],
      ["UCP_BUSINESS_SIGNING_PRIVATE_JWK", "ucp_business_signing_private_jwk"],
      ["UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS", "ucp_business_signing_previous_public_jwks"],
      ["UCP_AP2_VERIFIER_URL", "ucp_ap2_verifier_url"],
      ["UCP_AP2_VERIFIER_AUTH_TOKEN", "ucp_ap2_verifier_auth_token"],
      ["UCP_AP2_VERIFIER_TIMEOUT_MS", "ucp_ap2_verifier_timeout_ms"],
    ];
    for (const [environmentName, terraformName] of ucpSecretEnvironmentNames) {
      expect(runtimeSecretsStep).toContain(`TF_VAR_${terraformName}:`);
      expect(runtimeSecretsStep).toContain(`export ${environmentName}="\${TF_VAR_${terraformName}`);
    }

    expect(requiredJob).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(requiredJob).toContain("needs['change-scope'].outputs.cluster_preview == 'true'");
    expect(requiredJob).toContain("contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(requiredJob).toContain(
      "Preview deployment and smoke must pass for same-repository deploy-surface PRs and manual preview-label PRs.",
    );
    expect(requiredJob).toContain(
      "Preview deployment had an unexpected result when it was not required: ${preview_result}.",
    );
  });

  it("keeps non-blocking coverage off merge groups and on a daily workflow", () => {
    const fastCoverageStep = workflowStep(platformCoverageWorkflow, "Run fast coverage");
    const dbCoverageStep = workflowStep(platformCoverageWorkflow, "Run DB coverage");
    const coverageSummaryStep = workflowStep(platformCoverageWorkflow, "Summarize aggregate coverage");

    expect(platformPrWorkflow).not.toContain("coverage-fast:");
    expect(platformPrWorkflow).not.toContain("coverage-db:");
    expect(platformPrWorkflow).not.toContain("coverage-summary:");
    expect(platformPrWorkflow).not.toContain("Fast Coverage (non-blocking)");
    expect(platformPrWorkflow).not.toContain("DB Coverage (non-blocking)");
    expect(platformPrWorkflow).not.toContain("Coverage Summary (non-blocking)");
    expect(platformPrWorkflow).not.toContain("coverage_fast:");
    expect(platformPrWorkflow).not.toContain("coverage_summary:");

    expect(platformCoverageWorkflow).toContain("name: Platform Coverage");
    expect(platformCoverageWorkflow).toContain('cron: "41 9 * * *"');
    expect(platformCoverageWorkflow).toContain("workflow_dispatch:");
    expect(platformCoverageWorkflow).toContain("ref:");
    expect(platformCoverageWorkflow).toContain("default: main");
    expect(platformCoverageWorkflow).toContain("group: platform-coverage-${{ github.event.inputs.ref || github.ref }}");
    expect(platformCoverageWorkflow).toContain("name: Fast Coverage (non-blocking)");
    expect(platformCoverageWorkflow).toContain("name: DB Coverage (non-blocking)");
    expect(platformCoverageWorkflow).toContain("name: Coverage Summary (non-blocking)");
    expect(platformCoverageWorkflow).toContain("continue-on-error: true");
    expect(platformCoverageWorkflow).toContain("coverage-fast-artifacts");
    expect(platformCoverageWorkflow).toContain("coverage-db-artifacts");
    expect(platformCoverageWorkflow).toContain("coverage-summary-artifacts");
    expect(platformCoverageWorkflow).toContain("retention-days: 7");
    expect(platformCoverageWorkflow).toContain(
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0",
    );

    expect(fastCoverageStep).toContain("node ./scripts/run-workspaces.mjs test --exclude-test-profile=db");
    expect(fastCoverageStep).toContain("node ./scripts/run-workspaces.mjs test:unit --test-profile=db");
    expect(fastCoverageStep).toContain("--coverage --coverage.reporter=text --coverage.reporter=lcov");
    expect(dbCoverageStep).toContain('node ./scripts/run-workspaces.mjs "test:db*" --concurrency=2');
    expect(dbCoverageStep).toContain("--coverage --coverage.reporter=text --coverage.reporter=lcov");
    expect(coverageSummaryStep).toContain(
      "--status=non-db:${{ needs['coverage-fast'].outputs.fast_status || 'not-run' }}",
    );
    expect(coverageSummaryStep).toContain(
      "--status=db-profile-unit:${{ needs['coverage-fast'].outputs.unit_status || 'not-run' }}",
    );
    expect(coverageSummaryStep).toContain("--status=db:${{ needs['coverage-db'].outputs.db_status || 'not-run' }}");
    expect(coverageSummaryStep).toContain('node ./scripts/coverage-summary.mjs "${statuses[@]}"');
  });

  it("gates the release image push behind a runtime boot smoke", () => {
    const buildStep = workflowStep(platformProductionWorkflow, "Build release image");
    expect(buildStep).toContain('release_commit="${{ needs.resolve-release.outputs.release_commit }}"');
    expect(buildStep).toContain("release_tree=\"$(git rev-parse 'HEAD^{tree}')\"");
    expect(buildStep).toContain(
      'tree_image="registry.digitalocean.com/${registry_name}/${PLATFORM_IMAGE_REPOSITORY}:tree-${release_tree}"',
    );
    expect(buildStep).toContain('docker buildx imagetools create --tag "$image" "$tree_image"');
    expect(buildStep).toContain('if [ "$release_digest" != "$tree_digest" ]; then');
    expect(buildStep).toContain("Promoted merge-queue validated image");
    expect(buildStep).toContain("skipping rebuild and boot smoke");
    expect(buildStep).toContain("--load \\");
    expect(buildStep).not.toContain("--push");
    expect(buildStep).toContain('echo "built=true" >> "$GITHUB_OUTPUT"');

    // The smoke mirrors runtime commands and health checks from
    // infrastructure/digitalocean/platform/main.tf so a non-booting image
    // fails the parallel build job instead of crashing the deploy lane
    // (issue #1417).
    const smokeStep = workflowStep(platformProductionWorkflow, "Boot smoke release image");
    expect(smokeStep).toContain("if: steps.release_image.outputs.built == 'true'");
    expect(smokeStep).toContain('boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready');
    expect(smokeStep).toContain('boot_smoke public-web "@chase-sets/app-public-web" /');

    const pushStep = workflowStep(platformProductionWorkflow, "Push release image");
    expect(pushStep).toContain('docker push "$RELEASE_IMAGE"');

    const buildIndex = platformProductionWorkflow.indexOf("- name: Build release image");
    const smokeIndex = platformProductionWorkflow.indexOf("- name: Boot smoke release image");
    const pushIndex = platformProductionWorkflow.indexOf("- name: Push release image");
    expect(buildIndex).toBeLessThan(smokeIndex);
    expect(smokeIndex).toBeLessThan(pushIndex);
  });

  it("keeps the release image dependency layer cacheable without pnpm fetch", () => {
    const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");

    // pnpm fetch over the lockfile looked equivalent but emitted bin shims
    // without the NODE_PATH preamble, breaking sharp's platform binary
    // resolution at runtime (issue #1417). The dependency layer must stay a
    // real install keyed on manifests only, ahead of the source copies.
    expect(dockerfile).not.toContain("RUN pnpm fetch");
    expect(dockerfile).toContain("COPY --chown=node:node --from=manifests /manifests ./");
    expect(dockerfile).toContain("RUN pnpm install --frozen-lockfile");
    expect(dockerfile.indexOf("RUN pnpm install --frozen-lockfile")).toBeLessThan(
      dockerfile.indexOf("COPY --chown=node:node bounded-contexts ./bounded-contexts"),
    );
    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS runtime");
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"));
    expect(runtimeStage).toContain("RUN pnpm install --frozen-lockfile --prod");
    expect(runtimeStage.indexOf("RUN pnpm install --frozen-lockfile --prod")).toBeLessThan(
      runtimeStage.indexOf("COPY --chown=node:node bounded-contexts ./bounded-contexts"),
    );
    expect(runtimeStage).toContain(
      "COPY --chown=node:node --from=build /app/deployables/public-web/build ./deployables/public-web/build",
    );
    expect(dockerfile).toContain("-name __tests__");
    expect(dockerfile).toContain('-name "*.test.*"');
  });

  it("runs the platform release image as the non-root node user", () => {
    const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");

    expect(dockerfile).toContain("ENV HOME=/home/node");
    expect(dockerfile).toContain("COPY --chown=node:node deployables ./deployables");
    expect(dockerfile).toContain("chown node:node /app");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain("pnpm run sync:workspace-metadata");
    expect(dockerfile.indexOf("USER node")).toBeLessThan(
      dockerfile.indexOf('CMD ["pnpm", "--filter", "@chase-sets/app-public-web", "run", "start"]'),
    );
    expect(dockerfile).not.toContain("chmod 777");
  });

  it("provides a confirmed CI path for live DOKS foundation proof", () => {
    expect(platformDoksFoundationWorkflow).toContain("name: Platform DOKS Foundation Apply");
    expect(platformDoksFoundationWorkflow).toContain('Type "apply doks foundation"');
    expect(platformDoksFoundationWorkflow).toContain('if [ "${{ inputs.confirm }}" != "apply doks foundation" ]');
    expect(platformDoksFoundationWorkflow).toContain("-backend-config=key=doks/${{ inputs.environment }}.tfstate");
    expect(platformDoksFoundationWorkflow).toContain("TF_VAR_kubernetes_version: ${{ inputs.kubernetes_version }}");
    expect(platformDoksFoundationWorkflow).toContain("terraform output -raw kubeconfig");
    expect(platformDoksFoundationWorkflow).toContain("kubectl wait --for=condition=Ready nodes --all");
    expect(platformDoksFoundationWorkflow).toContain("registry.digitalocean.com/chase-sets/chase-sets-platform");
    expect(platformDoksFoundationWorkflow).toContain("kubectl create job platform-image-pull-proof");
    expect(platformDoksFoundationWorkflow).toContain("platform-doks-foundation-${{ inputs.environment }}");
  });

  it("pins preview workloads to the dedicated preview node pool scheduling contract", () => {
    // The staging DOKS preview node pool itself (label, taint, scale-to-zero
    // autoscaling) ships separately with #4745 and is guarded by
    // scripts/doks-preview-node-pool.test.mjs. This guard pins the deploy-side
    // wiring: the preview deploy path pins every preview workload to the pool
    // via nodeSelector + taint toleration; other environments never set these.
    expect(platformKubernetesDeploymentScript).toContain('envOverrides.DEPLOYMENT_ENVIRONMENT === "preview"');
    expect(platformKubernetesDeploymentScript).toContain('"global.nodeSelector.chase-sets\\\\.com/pool=preview"');
    expect(platformKubernetesDeploymentScript).toContain('"global.tolerations[0].key=chase-sets.com/preview-only"');
    expect(platformKubernetesDeploymentScript).toContain('"global.tolerations[0].effect=NoSchedule"');

    // The in-cluster preview Postgres pod schedules with the same values as
    // the component workloads (which render them through the podSpec helper).
    expect(previewPostgresTemplate).toContain(".Values.global.nodeSelector");
    expect(previewPostgresTemplate).toContain(".Values.global.tolerations");
  });

  it("#4857: previews never publish per-preview DNS or issue their own certificate", () => {
    const deployJob = workflowJob(platformPrWorkflow, "preview-deploy-smoke");

    // The per-PR apex + wildcard DNS publish step and the per-PR ACME
    // certificate wait are both gone: previews resolve through the ONE
    // shared `*.preview.chasesets.com` wildcard DNS record and TLS
    // certificate, bootstrapped once (docs/runbooks/doks-platform-operations.md),
    // never per-PR. A per-PR-issuance design exhausted Let's Encrypt's
    // 50-certificates-per-168h quota and blocked every PR for three hours.
    expect(deployJob).not.toContain("Publish preview DNS records");
    expect(deployJob).not.toContain("apply-dns");
    expect(deployJob).not.toContain("Wait for preview TLS certificate");
    expect(deployJob).not.toContain("kubectl wait --for=condition=Ready");
    expect(deployJob).not.toContain("DOKS_INGRESS_TARGET");

    // Teardown still cleans up any per-preview DNS record created before this
    // fix (created outside Terraform, so Terraform destroy never removes it);
    // no PR closing today creates a new one for it to find.
    const destroyStep = workflowStep(platformPreviewCleanupWorkflow, "Delete preview DNS records");
    expect(destroyStep).toContain("node scripts/digitalocean-preview-cleanup-sweep.mjs destroy-dns");
    expect(destroyStep).toContain('--pr-number "${{ matrix.pr_number }}"');

    // Runbook documents the shared preview DNS + TLS design and the one-time
    // bootstrap commands (doks-cluster-addons.mjs + apply-shared-dns).
    expect(digitaloceanPlatformRunbook).toContain("Preview DNS And TLS");
    expect(digitaloceanPlatformRunbook).toContain("apply-shared-dns");
    expect(digitaloceanPlatformRunbook).toContain("preview-wildcard-tls");
    expect(digitaloceanPlatformRunbook).toContain("copyPreviewWildcardTlsSecret");
  });

  it("#4857: preview deploy copies the shared wildcard TLS secret, then a fast presence check confirms it before probing https", () => {
    const deployJob = workflowJob(platformPrWorkflow, "preview-deploy-smoke");
    const verifyStep = workflowStep(deployJob, "Verify preview TLS secret");

    // A fast presence check (single `kubectl get`), not a poll: the deploy
    // step already copies the shared secret and fails loudly if it is
    // missing (copyPreviewWildcardTlsSecret in platform-kubernetes-deployment.mjs).
    expect(verifyStep).toContain('secret_name="preview-wildcard-tls"');
    expect(verifyStep).toContain('namespace="$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(verifyStep).toContain('kubectl get "secret/${secret_name}"');
    expect(verifyStep).not.toContain("kubectl wait");
    expect(verifyStep).not.toContain("--timeout=600s");

    // Sits after the Helm deploy (which performs the copy) and before the
    // https ingress-URL readiness probes, which then pass quickly.
    const deployIndex = deployJob.indexOf("- name: Deploy preview Kubernetes release");
    const verifyIndex = deployJob.indexOf("- name: Verify preview TLS secret");
    const waitIndex = deployJob.indexOf("- name: Wait for preview ingress URLs");
    expect(verifyIndex).toBeGreaterThan(deployIndex);
    expect(verifyIndex).toBeLessThan(waitIndex);

    // The app-host https /health/ready probes remain the final end-to-end gate,
    // now against single-label hosts.
    const waitStep = workflowStep(deployJob, "Wait for preview ingress URLs");
    expect(waitStep).toContain('admin_domain="${PREVIEW_IDENTIFIER}-admin.preview.chasesets.com"');
    expect(waitStep).toContain('marketplace_domain="${PREVIEW_IDENTIFIER}-marketplace.preview.chasesets.com"');
    expect(waitStep).toContain('"https://${admin_domain}/health/ready"');
    expect(waitStep).toContain('"https://${marketplace_domain}/health/ready"');

    // Every preview namespace references the same shared secret name, not a
    // per-preview derived name.
    expect(renderPlatformHelmValuesScript).toContain(
      'export const previewWildcardTlsSecretName = "preview-wildcard-tls"',
    );
    expect(renderPlatformHelmValuesScript).not.toContain("secretName: `${previewIdentifier}-platform-tls`");
  });

  it("gates route-matrix evidence generation on the segment-level projection lag SLO regression gate", () => {
    expect(platformStagingRouteMatrixEvidenceWorkflow).toContain(
      "Evaluate segment-level projection lag SLO regression gate",
    );
    expect(platformStagingRouteMatrixEvidenceWorkflow).toContain(
      "pnpm run ops release-health:report -- \\\n            --dir artifacts/wake-drills \\\n            --gate \\",
    );
    expect(platformStagingRouteMatrixEvidenceWorkflow).toContain(
      "artifacts/wake-drills/release-health-segment-slo-gate.md",
    );
    expect(platformStagingRouteMatrixEvidenceWorkflow).toContain(
      "Segment-level projection lag SLO regression gate failed",
    );
  });

  it("uses one checked-in script for Terraform-state database URL exports in operational workflows", () => {
    const wakeDrillsStep = workflowStep(platformStagingWakeDrillsWorkflow, "Export staging database URLs");
    const representativeStateStep = workflowStep(platformRepresentativeWorkflow, "Export staging database URLs");
    const providerProofStep = workflowStep(
      marketplaceProviderProofStatusWorkflow,
      "Export provider proof database URLs",
    );
    const steps = [wakeDrillsStep, representativeStateStep, providerProofStep];

    for (const step of steps) {
      expect(step).toContain("uses: ./.github/actions/export-managed-postgres-authority");
      expect(step).not.toContain("node <<'NODE'");
      expect(step).not.toContain("digitalocean_database_cluster");
    }
    expect(exportManagedPostgresAuthorityAction).toContain("terraform state pull");
    expect(exportManagedPostgresAuthorityAction).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
    expect(exportManagedPostgresAuthorityAction).toContain('--state "$state_path"');
    expect(exportManagedPostgresAuthorityAction).toContain('--github-env "$GITHUB_ENV"');
    expect(providerProofStep).toContain("contexts: payments,settlement,fulfillment");
  });

  it("keeps application deployment inputs at job scope and narrows root provider authority to each step", () => {
    const stagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const resetJob = workflowJob(platformStagingResetWorkflow, "reset-staging");

    for (const job of [stagingJob, productionJob, resetJob]) {
      expect(job).toContain("TF_VAR_platform_internal_auth_secret: ${{ secrets.PLATFORM_INTERNAL_AUTH_SECRET }}");
      expect(job).toContain("TF_VAR_platform_admin_email: ${{ secrets.PLATFORM_ADMIN_EMAIL }}");
      expect(job).toContain("TF_VAR_platform_admin_password: ${{ secrets.PLATFORM_ADMIN_PASSWORD }}");
      expect(job).toContain("TF_VAR_discord_invite_url: ${{ secrets.CHASE_SETS_DISCORD_INVITE_URL }}");
      expect(job).toContain("TF_VAR_notification_email_provider: ${{ vars.NOTIFICATION_EMAIL_PROVIDER || 'noop' }}");
      expect(job).toContain("TF_VAR_observability_otlp_headers: ${{ secrets.OBSERVABILITY_OTLP_HEADERS || '' }}");
      const jobHeader = job.split("\n    steps:")[0];
      expect(jobHeader).not.toContain("TF_VAR_digitalocean_token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
      expect(jobHeader).not.toContain("TF_VAR_spaces_access_id: ${{ secrets.SPACES_ACCESS_ID }}");
      expect(jobHeader).not.toContain("TF_VAR_spaces_secret_key: ${{ secrets.SPACES_SECRET_KEY }}");
    }

    expect(stagingJob).toContain("TF_VAR_stripe_api_base_url: ${{ vars.STRIPE_API_BASE_URL || '' }}");
    expect(stagingJob).toContain("TF_VAR_stripe_connect_accounts_api: ${{ vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2' }}");
    expect(stagingJob).toContain("TF_VAR_easypost_webhook_secret: ${{ secrets.EASYPOST_WEBHOOK_SECRET || '' }}");
    expect(productionJob).toContain(
      "TF_VAR_stripe_api_base_url: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && vars.STRIPE_API_BASE_URL || '' }}",
    );
    expect(productionJob).toContain(
      "TF_VAR_stripe_connect_accounts_api: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && (vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2') || 'v2' }}",
    );
    expect(productionJob).toContain(
      "TF_VAR_easypost_webhook_secret: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && secrets.EASYPOST_WEBHOOK_SECRET || '' }}",
    );
    expect(resetJob).toContain('echo "TF_VAR_platform_image_tag=${release_commit}" >> "$GITHUB_ENV"');

    const deployPlanApplySteps = [
      ...workflowSteps(platformProductionWorkflow, "Terraform plan"),
      ...workflowSteps(platformProductionWorkflow, "Terraform apply"),
    ];

    for (const step of deployPlanApplySteps) {
      expect(carriesExactProviderCredentials(step)).toBe(true);
      for (const binding of [
        "TF_VAR_digitalocean_token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
        "TF_VAR_spaces_access_id: ${{ secrets.SPACES_ACCESS_ID }}",
        "TF_VAR_spaces_secret_key: ${{ secrets.SPACES_SECRET_KEY }}",
      ]) {
        expect(carriesExactProviderCredentials(step.replaceAll(binding, ""))).toBe(false);
      }
    }

    const resetPlanApplySteps = [
      ...workflowSteps(platformStagingResetWorkflow, "Terraform plan staging recreate"),
      ...workflowSteps(platformStagingResetWorkflow, "Terraform apply staging recreate"),
    ];
    for (const step of resetPlanApplySteps) {
      expect(carriesExactProviderCredentials(step)).toBe(true);
      for (const binding of [
        "TF_VAR_digitalocean_token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
        "TF_VAR_spaces_access_id: ${{ secrets.SPACES_ACCESS_ID }}",
        "TF_VAR_spaces_secret_key: ${{ secrets.SPACES_SECRET_KEY }}",
      ]) {
        expect(carriesExactProviderCredentials(step.replaceAll(binding, ""))).toBe(false);
      }
    }
  });

  it("uses scoped DigitalOcean tokens for advisory and cleanup workflows", () => {
    expect(platformDigitalOceanDriftDigestWorkflow).toContain(
      "DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_READONLY_TOKEN }}",
    );
    expect(platformDigitalOceanDriftDigestWorkflow).toContain("token: ${{ secrets.DIGITALOCEAN_READONLY_TOKEN }}");
    expect(platformDigitalOceanDriftDigestWorkflow).not.toContain("${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");

    expect(platformRegistryCleanupWorkflow).toContain(
      "DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_REGISTRY_TOKEN }}",
    );
    expect(platformRegistryCleanupWorkflow).toContain("token: ${{ secrets.DIGITALOCEAN_REGISTRY_TOKEN }}");
    expect(platformRegistryCleanupWorkflow).not.toContain("${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");

    for (const destructiveWorkflow of [
      platformPrWorkflow,
      platformProductionWorkflow,
      platformPreviewCleanupWorkflow,
      platformStagingResetWorkflow,
      platformDatabaseRestoreDrillWorkflow,
      platformProductionRestorePointCleanupWorkflow,
      platformRollbackReadinessWorkflow,
    ]) {
      expect(destructiveWorkflow).toContain("${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    }
    expect(platformEmergencyRecoveryWorkflow).not.toContain("DIGITALOCEAN_READONLY_TOKEN");
    expect(platformEmergencyRecoveryWorkflow).not.toContain("DIGITALOCEAN_REGISTRY_TOKEN");

    expect(digitaloceanPlatformRunbook).toContain("DigitalOcean API Token Scope Inventory");
    expect(digitaloceanPlatformRunbook).toContain("`DIGITALOCEAN_READONLY_TOKEN`");
    expect(digitaloceanPlatformRunbook).toContain("`DIGITALOCEAN_REGISTRY_TOKEN`");
    expect(digitaloceanPlatformRunbook).toContain(
      "Spaces and Terraform-state least privilege remain separate follow-up work.",
    );
  });

  it("maps the sole production restore-point hold authority into the drift digest alias exactly once", () => {
    const mapping =
      "DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES: ${{ vars.PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES || '' }}";

    expect(platformDigitalOceanDriftDigestWorkflow.split(mapping)).toHaveLength(2);
    expect(
      platformDigitalOceanDriftDigestWorkflow.split("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES"),
    ).toHaveLength(2);
    expect(platformDigitalOceanDriftDigestWorkflow.split("DIGITALOCEAN_DRIFT_RESTORE_POINT_HOLD_NAMES")).toHaveLength(
      2,
    );
  });

  it("renders total restore-point hold authority fields without exposing tokens or breaking older records", () => {
    const summaryStep = workflowStep(platformDigitalOceanDriftDigestWorkflow, "Summarize drift digest");
    const retainedSummaryLines = [
      "Result",
      "Mode",
      "Observed resources",
      "Terraform-managed resources",
      "Unknown Chase Sets resources",
      "Cleanup candidates",
      "Held restore points",
      "Advisory findings",
      "Warning findings",
      "Collection errors",
    ];
    const holdSummaryLines = [
      "Restore point hold authority",
      "Restore point hold tokens",
      "Restore point holds applied",
      "Restore point holds unmatched",
      "Restore point hold fingerprint",
    ];

    expect(summaryStep).toContain("if: ${{ always() }}");
    for (const label of [...retainedSummaryLines, ...holdSummaryLines]) {
      expect(summaryStep).toContain(`console.log(\`- ${label}:`);
    }
    const safeSummaryBlock = summaryStep.split("if (record.findings?.length)")[0];
    expect(safeSummaryBlock.match(/console\.log\(`- /g)).toHaveLength(15);
    expect(summaryStep).toContain("const restorePointHolds = record.policies?.restorePointHolds ?? {};");
    expect(summaryStep).toContain('restorePointHolds.status ?? "absent"');
    expect(summaryStep).toContain("restorePointHolds.tokenCount ?? 0");
    expect(summaryStep).toContain("restorePointHolds.appliedCount ?? 0");
    expect(summaryStep).toContain("restorePointHolds.unmatchedCount ?? 0");
    expect(summaryStep).toContain('restorePointHolds.effectiveTokenSetSha256 ?? "none"');
    expect(summaryStep).not.toContain("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES");
    expect(summaryStep).not.toContain("restorePointHoldNames");
  });

  it("cleans preview environments on PR close and with a daily closed-PR sweep", () => {
    expect(platformPreviewCleanupWorkflow).toContain("pull_request_target:");
    expect(platformPreviewCleanupWorkflow).toContain("types:\n      - closed");
    expect(platformPreviewCleanupWorkflow).toContain('cron: "17 10 * * *"');
    expect(platformPreviewCleanupWorkflow).toContain("workflow_dispatch:");
    expect(platformPreviewCleanupWorkflow).toContain("discover-preview-cleanup:");
    expect(platformPreviewCleanupWorkflow).toContain("node ./scripts/digitalocean-preview-cleanup-sweep.mjs discover");
    expect(platformPreviewCleanupWorkflow).toContain(
      "--out artifacts/release-health/platform-preview-cleanup-sweep.json",
    );
    expect(platformPreviewCleanupWorkflow).toContain("target_count: ${{ steps.targets.outputs.target_count }}");
    expect(platformPreviewCleanupWorkflow).toContain("if: needs.discover-preview-cleanup.outputs.target_count != '0'");
    expect(platformPreviewCleanupWorkflow).toContain(
      "matrix: ${{ fromJSON(needs.discover-preview-cleanup.outputs.matrix) }}",
    );
    expect(platformPreviewCleanupWorkflow).toContain("group: platform-preview-pr-${{ matrix.pr_number }}");
    expect(platformPreviewCleanupWorkflow).toContain("TF_VAR_preview_identifier: pr-${{ matrix.pr_number }}");
    expect(platformPreviewCleanupWorkflow).toContain(
      "TF_VAR_platform_image_tag: pr-${{ matrix.pr_number }}-${{ matrix.image_sha }}",
    );
    expect(platformPreviewCleanupWorkflow).toContain("ref: ${{ matrix.checkout_ref }}");
    expect(platformPreviewCleanupWorkflow).toContain(
      "-backend-config=key=platform/previews/pr-${{ matrix.pr_number }}.tfstate",
    );
    expect(platformPreviewCleanupWorkflow).not.toContain("Wait for active App Platform deployment");
    expect(platformPreviewCleanupWorkflow).not.toContain("digitalocean-app-deployment.mjs");
    expect(digitaloceanPlatformRunbook).toContain(
      "Inspect the uploaded cleanup logs before removing a legacy state key by hand.",
    );
    expect(digitaloceanPlatformRunbook).not.toContain("waits for any active App Platform deployment to finish");
    expect(digitaloceanPlatformRunbook).not.toContain(
      "the DigitalOcean deployment helper treats the missing app as no active deployment to wait for",
    );
  });

  it("opens or updates the quarterly DigitalOcean token rotation issue without DO secrets", () => {
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain(
      "name: Platform DigitalOcean Token Rotation Reminder",
    );
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain('cron: "17 14 6 1,4,7,10 *"');
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toMatch(/\n  workflow_dispatch:\n/);
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("issues: write");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain(
      'ROTATION_ISSUE_TITLE: "[ops] Rotate DigitalOcean tokens"',
    );
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("gh issue edit");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("gh issue create");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("DIGITALOCEAN_ACCESS_TOKEN");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("DIGITALOCEAN_READONLY_TOKEN");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("DIGITALOCEAN_REGISTRY_TOKEN");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("90-day expiration");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain(
      "DigitalOcean Control Panel -> Account -> API -> Tokens",
    );
    expect(platformDigitalOceanTokenRotationReminderWorkflow).not.toContain("${{ secrets.");
    expect(platformDigitalOceanTokenRotationReminderWorkflow).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("uploads Terraform plan text artifacts without retaining raw JSON plans", () => {
    const stagingPlanStep = workflowStep(platformProductionWorkflow, "Terraform plan");
    const productionPlanStep = workflowSteps(platformProductionWorkflow, "Terraform plan").at(-1);
    const stagingUploadStep = workflowStep(platformProductionWorkflow, "Upload staging Terraform plan");
    const productionUploadStep = workflowStep(platformProductionWorkflow, "Upload production Terraform plan");

    expect(stagingPlanStep).toContain("terraform show -json tfplan > artifacts/terraform-plans/staging-tfplan.json");
    expect(productionPlanStep).toContain(
      "terraform show -json tfplan > artifacts/terraform-plans/production-tfplan.json",
    );
    expect(stagingUploadStep).toContain(
      "path: infrastructure/digitalocean/platform/artifacts/terraform-plans/staging-tfplan.txt",
    );
    expect(productionUploadStep).toContain(
      "path: infrastructure/digitalocean/platform/artifacts/terraform-plans/production-tfplan.txt",
    );
    expect(stagingUploadStep).not.toContain("staging-tfplan.*");
    expect(stagingUploadStep).not.toContain("staging-tfplan.json");
    expect(productionUploadStep).not.toContain("production-tfplan.*");
    expect(productionUploadStep).not.toContain("production-tfplan.json");
  });

  it("provisions the checked-in observability stack behind scoped public endpoints", () => {
    expect(observabilityMain).toContain('resource "digitalocean_droplet" "observability"');
    expect(observabilityMain).toContain('resource "digitalocean_volume" "observability_data"');
    expect(observabilityMain).toContain('resource "digitalocean_firewall" "observability"');
    expect(observabilityMain).toContain('resource "digitalocean_record" "observability_a"');
    expect(observabilityMain).toContain("for_each = local.endpoint_dns_records");
    expect(observabilityMain).toContain('from = digitalocean_record.observability_a["grafana"]');
    expect(observabilityMain).toContain('to   = digitalocean_record.observability_a["production-grafana"]');
    expect(observabilityMain).toContain('from = digitalocean_record.observability_a["otel"]');
    expect(observabilityMain).toContain('to   = digitalocean_record.observability_a["production-otel"]');
    expect(observabilityMain).toContain('from = digitalocean_record.observability_a["prometheus"]');
    expect(observabilityMain).toContain('to   = digitalocean_record.observability_a["production-prometheus"]');
    expect(observabilityMain).toContain("backups    = var.droplet_backups_enabled");
    expect(observabilityMain).toContain('check "observability_storage_posture"');
    expect(observabilityMain).toContain('check "observability_retention_posture"');
    expect(observabilityMain).toContain('check "observability_alert_delivery"');
    expect(observabilityMain).toContain('check "observability_cloud_init_size"');
    expect(observabilityMain).toContain('check "observability_stack_file_classification"');
    expect(observabilityMain).toContain("length(local.cloud_init_user_data) < 64000");
    expect(observabilityMain).toContain("length(local.unclassified_stack_files) == 0");
    expect(observabilityVariables).toContain('variable "droplet_backups_enabled"');
    expect(observabilityVariables).toContain("default     = false");
    expect(observabilityVariables).toContain('variable "observability_environments"');
    expect(observabilityVariables).toContain('variable "stack_environment"');
    expect(observabilityVariables).toContain('variable "alert_emails"');
    expect(observabilityVariables).toContain('variable "ses_aws_secret_access_key"');
    expect(observabilityVariables).toContain('variable "acceptable_telemetry_data_loss_window_hours"');
    expect(observabilityMain).toContain('port_range       = "80"');
    expect(observabilityMain).toContain('port_range       = "443"');
    expect(observabilityLocals).toContain("../../observability/stack");
    expect(observabilityLocals).toContain('fileset(local.stack_source_dir, "**/*")');
    expect(observabilityLocals).toContain("stack_file_exclusions = toset([])");
    expect(observabilityLocals).toContain('setsubtract(fileset(local.stack_source_dir, "**/*")');
    expect(observabilityLocals).toContain('"collector-config.yml" = templatefile');
    expect(observabilityLocals).toContain('"prometheus.yml" = templatefile');
    expect(observabilityLocals).toContain("environment_zones");
    expect(observabilityLocals).toContain("endpoint_dns_records");
    expect(observabilityLocals).toContain("grafana_domains        = join");
    expect(observabilityLocals).toContain("otel_domains           = join");
    expect(observabilityLocals).toContain('encoding    = "gz+b64"');
    expect(observabilityLocals).toContain("content     = base64gzip(content)");
    expect(observabilityLocals).toContain("cloud_init_user_data = templatefile");
    expect(observabilityCollectorTemplate).toContain("deployment.environment");
    expect(observabilityCollectorTemplate).toContain("value: ${stack_environment}");
    expect(observabilityCollectorTemplate).toContain("resource_to_telemetry_conversion");
    expect(observabilityCollectorTemplate).not.toContain("value: local");
    expect(observabilityPrometheusTemplate).toContain("target_label: deployment_environment");
    expect(observabilityPrometheusTemplate).toContain("replacement: ${stack_environment}");
    expect(observabilityPrometheusTemplate).toContain("target_label: chase_sets_observability_stack");
    expect(observabilityPrometheusTemplate).toContain("single-shared-stack");
    expect(observabilityCaddyfile).toContain("${grafana_domains}");
    expect(observabilityCaddyfile).toContain("${otel_domains}");
    expect(observabilityCaddyfile).toContain("${prometheus_domains}");
    expect(observabilityCaddyfile).toContain("@authorized header X-Chase-Sets-Observability-Token");
    expect(observabilityCaddyfile).toContain("@authorized header X-Chase-Sets-Observability-Query");
    expect(observabilityDockerCompose).toContain("/var/lib/chase-sets-observability/diagnostics:/srv/diagnostics:ro");
    expect(observabilityDockerCompose).toContain("condition: service_started");
    expect(observabilityDockerCompose).toContain("http://127.0.0.1:3000/api/health");
    expect(observabilityDockerCompose).toContain('GF_SMTP_ENABLED: "$${GRAFANA_SMTP_ENABLED}"');
    expect(observabilityDockerCompose).toContain('SES_AWS_ACCESS_KEY_ID: "$${SES_AWS_ACCESS_KEY_ID}"');
    expect(observabilityDockerCompose).toContain("./ses-smtp-relay.mjs:/app/ses-smtp-relay.mjs:ro");
    expect(observabilityContactPointsTemplate).toContain("chase-sets-platform-alert-email");
    expect(observabilityContactPointsTemplate).toContain("addresses: ${alert_emails}");
    expect(observabilityCaddyfile).toContain("/__chase-sets/observability/boot-status");
    expect(observabilityCloudInit).toContain("chase-sets-observability-diagnostics");
    expect(observabilityCloudInit).toContain("chase-sets-observability-diagnostics.timer");
    expect(observabilityCloudInit).toContain("docker compose logs --no-color --tail=80 grafana");
    expect(observabilityCloudInit).toContain("docker compose logs --tail=120 grafana");
    expect(observabilityCloudInit).toContain("docker compose up -d --remove-orphans");
    expect(observabilityOutputs).toContain('output "app_platform_otlp_headers"');
    expect(observabilityOutputs).toContain('output "environment_endpoints"');
    // The canary-evidence promotion gate was removed in #2507, so the host no
    // longer exports canary_prometheus_* outputs. The scoped query-auth token
    // (X-Chase-Sets-Observability-Query, asserted above) stays for dashboards.
    expect(observabilityOutputs).not.toContain("canary_prometheus");
  });

  it("reconfigures Terraform whenever the observability migration switches state keys", () => {
    expect(occurrenceCount(platformObservabilityStateMigrationWorkflow, "-reconfigure")).toBe(2);
    expect(platformObservabilityStateMigrationWorkflow).toContain('-state="$shared_work"');
  });

  it("preserves the live SSH posture during the observability state migration", () => {
    expect(platformObservabilityStateMigrationWorkflow).toContain(
      "TF_VAR_ssh_key_fingerprints: ${{ vars.OBSERVABILITY_SSH_KEY_FINGERPRINTS || '[]' }}",
    );
    expect(platformObservabilityStateMigrationWorkflow).toContain(
      "TF_VAR_ssh_source_addresses: ${{ vars.OBSERVABILITY_SSH_SOURCE_ADDRESSES || '[]' }}",
    );
  });

  it("keeps every checked-in observability stack file deployed or explicitly excluded", () => {
    const stackFiles = listFilesRecursively(resolve("infrastructure/observability/stack"));

    expect(stackFiles).toContain("grafana/dashboards/catalog-integration-control-plane.json");
    expect(stackFiles).toContain("grafana/provisioning/alerting/catalog-integration-alerts.yml");
    expect(observabilityLocals).toContain("stack_file_paths = sort(tolist(setsubtract(");
    expect(observabilityLocals).toContain("local.stack_file_exclusions");
    expect(observabilityLocals).toContain("unclassified_stack_files = setsubtract(");
    expect(observabilityLocals).toContain("setunion(toset(keys(local.stack_files)), local.stack_file_exclusions)");
  });

  it("keeps production managed Postgres standby posture guarded and alerting source-owned", () => {
    expect(platformVariables).toContain('variable "production_database_standby_approved"');
    expect(platformVariables).toContain('variable "production_database_standby_reference"');
    expect(platformVariables).toContain('variable "managed_postgres_alerts_enabled"');
    expect(platformVariables).toContain("Production must stay at 1 until production_database_standby_approved");
    expect(platformLocals).toContain("production_database_standby_desired_node_count = 2");
    expect(platformLocals).toContain('traffic_posture          = "primary-only-runtime-bindings"');
    expect(platformLocals).toContain("read_traffic_to_standbys = false");
    expect(platformMain).toContain('check "production_database_standby_approval"');
    expect(platformMain).toContain('resource "digitalocean_monitor_alert" "managed_postgres"');
    expect(platformMain).toContain("entities    = [digitalocean_database_cluster.postgres[0].id]");
    expect(platformLocals).toContain('"v1/dbaas/alerts/disk_utilization_alerts"');
    expect(platformLocals).toContain('"v1/dbaas/alerts/memory_utilization_alerts"');
    expect(platformLocals).toContain('"v1/dbaas/alerts/cpu_alerts"');
    expect(platformLocals).toContain('"v1/dbaas/alerts/load_15_alerts"');
    expect(platformOutputs).toContain('output "production_database_standby_posture"');
    expect(platformOutputs).toContain('output "managed_postgres_alert_policies"');
    expect(platformPostgresGrowthEvidenceWorkflow).toContain('CONNECTION_UTILIZATION_WARNING_PERCENT: "80"');
    expect(platformPostgresGrowthEvidenceWorkflow).toContain("--connection-utilization-warning-percent");
  });

  it("keeps representative commerce refresh as an explicit staging-only operator workflow", () => {
    expect(platformRepresentativeWorkflow).toContain("environment: staging");
    expect(platformRepresentativeWorkflow).toContain("seed staging commerce");
    expect(platformRepresentativeWorkflow).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(platformRepresentativeWorkflow).toContain("REPRESENTATIVE_COMMERCE_STATE_CATALOG_ITEM_LIMIT");
    expect(platformRepresentativeWorkflow).toContain("REPRESENTATIVE_COMMERCE_STATE_STEP_TIMEOUT_MS");
    expect(platformRepresentativeWorkflow).toContain('default: "300000"');
    expect(platformRepresentativeWorkflow).toContain("uses: ./.github/actions/export-managed-postgres-authority");
    expect(platformRepresentativeWorkflow).toContain("environment: staging");
    expect(exportManagedPostgresAuthorityAction).toContain("terraform state pull");
    expect(exportManagedPostgresAuthorityAction).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
    expect(exportManagedPostgresAuthorityAction).toContain('--github-env "$GITHUB_ENV"');
    expect(platformRepresentativeWorkflow).toContain("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND: s3");
    expect(platformRepresentativeWorkflow).toContain(
      "pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production",
    );
    expect(platformProductionWorkflow).not.toContain("representative-commerce-state:production");
  });

  it("records the DOKS release and namespace in emergency and rollback-readiness evidence", () => {
    for (const workflow of [platformEmergencyRecoveryWorkflow, platformRollbackReadinessWorkflow]) {
      expect(workflow).toContain("CHASE_SETS_HELM_RELEASE: chase-sets-platform");
      expect(workflow).toContain("CHASE_SETS_KUBERNETES_NAMESPACE: chase-sets-platform");
      expect(workflow).toContain("CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT: 15m");
      expect(workflow).not.toMatch(/app-platform|App Platform/);
    }
    expect(platformEmergencyRecoveryWorkflow).toContain("rollback_revision");
    expect(platformEmergencyRecoveryWorkflow).toContain(
      "CHASE_SETS_HELM_ROLLBACK_REVISION: ${{ inputs.rollback_revision }}",
    );
  });

  it("bounds production stale pending-upgrade recovery to the exact #7504 main workflow", () => {
    const recoveryJob = workflowJob(
      platformProductionStaleHelmRecoveryWorkflow,
      "recover-production-stale-helm-upgrade",
    );
    const authenticateStep = workflowStep(recoveryJob, "Authenticate immutable recovery identities");
    const contextStep = workflowStep(recoveryJob, "Configure production Kubernetes context");
    const ociStep = workflowStep(recoveryJob, "Authenticate production OCI identity");
    const recoverStep = workflowStep(recoveryJob, "Recover exact stable stale pending-upgrade frontier");
    const verifyIdentitiesStep = workflowStep(recoveryJob, "Verify immutable identities after recovery");
    const uploadStep = workflowStep(recoveryJob, "Upload production stale Helm recovery evidence");

    expect(platformProductionStaleHelmRecoveryWorkflow).toContain("group: platform-registry-mutation");
    expect(platformProductionStaleHelmRecoveryWorkflow).toContain("cancel-in-progress: false");
    expect(platformProductionStaleHelmRecoveryWorkflow).toContain("actions: read");
    expect(platformProductionStaleHelmRecoveryWorkflow).toContain("recover issue 7504 stale pending upgrade");
    expect(platformProductionStaleHelmRecoveryWorkflow).toContain(
      "https://github.com/chase-sets/chase-sets/issues/7504",
    );
    expect(platformProductionStaleHelmRecoveryWorkflow).toContain("github.ref != 'refs/heads/main'");
    expect(recoveryJob).toContain("environment: production");
    expect(recoveryJob).not.toMatch(/branches\/main\/protection|deployment-branch-policies|can_admins_bypass/);
    expect(recoveryJob).not.toMatch(/recovery-authority|recovery-retry|prevent_self_review|required_reviewers/);

    expect(authenticateStep).toContain("git/ref/heads/main");
    expect(authenticateStep).toContain('if [ "$GITHUB_SHA" != "$current_main" ]');
    expect(authenticateStep).toContain('marker_commit="$(git rev-parse origin/production)"');
    expect(authenticateStep).toContain('if [ "$marker_commit" != "$RECOVERY_MARKER_COMMIT" ]');
    expect(authenticateStep).toContain('tag_commit="$(git rev-list -n 1 "$RECOVERY_RELEASE_TAG")"');
    expect(contextStep).toContain("doks/production.tfstate");
    expect(contextStep).toContain("terraform output -raw cluster_id");
    expect(contextStep).toContain("terraform output -raw cluster_name");
    expect(contextStep).not.toMatch(/terraform\s+(?:apply|destroy)|helm\s+(?:rollback|upgrade|uninstall)/);

    expect(ociStep).toContain('if [ "$registry_name" != "chase-sets" ]');
    expect(ociStep).toContain('if [ "$index_digest" != "$RECOVERY_OCI_INDEX_DIGEST" ]');
    expect(ociStep).toContain("docker buildx imagetools inspect");
    expect(recoverStep).toContain("recover-stale-pending-upgrade");
    expect(recoverStep).toContain('--revision "$RECOVERY_SOURCE_REVISION"');
    expect(recoverStep).toContain('--pending-revision "$RECOVERY_PENDING_REVISION"');
    expect(recoverStep).toContain('--source-description "$RECOVERY_SOURCE_DESCRIPTION"');
    expect(recoverStep).toContain('--pending-description "$RECOVERY_PENDING_DESCRIPTION"');
    expect(recoverStep).toContain('--admission-out "$evidence_dir/admission.json"');
    expect(recoverStep).toContain('--out "$evidence_dir/recovery.json"');
    expect(recoverStep).not.toMatch(/helm\s+(?:rollback|upgrade|uninstall)|kubectl\s+(?:patch|delete)/);
    expect(verifyIdentitiesStep).toContain('if [ "$marker_commit" != "$RECOVERY_MARKER_COMMIT" ]');
    expect(verifyIdentitiesStep).toContain('[ "$index_digest" != "$RECOVERY_OCI_INDEX_DIGEST" ]');
    expect(verifyIdentitiesStep).toContain(
      '[ "${{ steps.recover.outputs.recovery_observed_digest }}" != "$RECOVERY_PLATFORM_DIGEST" ]',
    );

    const orderedSteps = [authenticateStep, contextStep, ociStep, recoverStep, verifyIdentitiesStep, uploadStep];
    expect(orderedSteps.map((step) => recoveryJob.indexOf(step))).toEqual(
      [...orderedSteps].map((step) => recoveryJob.indexOf(step)).sort((left, right) => left - right),
    );
    expect(uploadStep).toContain("if: always()");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).toContain(
      "platform-production-stale-helm-recovery-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  it("captures production rollback identity before mutation and passes the exact successful revision", () => {
    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const captureStep = workflowStep(productionJob, "Capture production rollback target");
    const deployStep = workflowStep(productionJob, "Deploy production Kubernetes release");
    const rollbackStep = workflowStep(productionJob, "Roll back production Kubernetes release");
    const releaseStateStep = workflowStep(productionJob, "Resolve terminal release state");
    const releaseHealthStep = workflowStep(productionJob, "Write release health summary");

    expect(productionJob.indexOf("- name: Capture production rollback target")).toBeLessThan(
      productionJob.indexOf("- name: Terraform apply"),
    );
    expect(productionJob.indexOf("- name: Reconcile production managed Postgres CA trust")).toBeLessThan(
      productionJob.indexOf("- name: Evaluate production rollback readiness"),
    );
    expect(captureStep).toContain("capture-rollback-target");
    expect(captureStep).toContain('--tag="$last_known_good_commit"');
    expect(captureStep).toContain('--digest="$rollback_digest"');
    expect(captureStep).toContain('rollback_digest="$(docker buildx imagetools inspect');
    expect(captureStep).toContain(
      'rollback_index_ref="registry.digitalocean.com/${registry_name}/${PLATFORM_IMAGE_REPOSITORY}@${rollback_digest}"',
    );
    expect(captureStep).toContain('docker buildx imagetools inspect "$rollback_index_ref" --raw');
    expect(captureStep).toContain('printf \'%s\' "$rollback_index_json" > "$rollback_index_path"');
    expect(captureStep).toContain('--index-manifest="$rollback_index_path"');
    expect(captureStep).toContain('--platform="linux/amd64"');
    expect(deployStep).toContain("platform:kubernetes-deployment -- deploy");
    expect(rollbackStep).toContain('--revision "${{ steps.rollback_target.outputs.rollback_source_revision }}"');
    expect(rollbackStep).toContain('--rollback-target "artifacts/release-health/production-rollback-target.json"');
    expect(rollbackStep).toContain("--runtime-env DEPLOYMENT_ENVIRONMENT=production");
    expect(rollbackStep).not.toContain("Helm rolled the production Kubernetes release back to the previous revision");
    expect(releaseStateStep).toContain('terminal_commit="$ROLLBACK_TARGET_COMMIT"');
    expect(releaseStateStep).toContain('terminal_digest="$ROLLBACK_OBSERVED_DIGEST"');
    expect(releaseHealthStep).toContain(
      "ROLLBACK_SOURCE_REVISION: ${{ steps.production_rollback.outputs.rollback_source_revision || '' }}",
    );
    expect(releaseHealthStep).toContain(
      "ROLLBACK_WORKLOAD_IDENTITIES: ${{ steps.production_rollback.outputs.rollback_workload_identities || '[]' }}",
    );
  });

  it("verifies and uploads the exact production Kubernetes transition before every failure handler and marker", () => {
    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const promoteStep = workflowStep(productionJob, "Promote production Argo Rollouts");
    const verifyStep = workflowStep(productionJob, "Verify production Kubernetes deployment transition");
    const uploadStep = workflowStep(productionJob, "Upload production Kubernetes deployment transition");
    const abortStep = workflowStep(productionJob, "Abort production Argo Rollouts");
    const diagnosticsStep = workflowStep(productionJob, "Capture post-cutover production Kubernetes diagnostics");
    const rollbackStep = workflowStep(productionJob, "Roll back production Kubernetes release");
    const markerStep = workflowStep(productionJob, "Mark production release");
    const releaseHealthUpload = workflowStep(productionJob, "Upload release health summary");

    const orderedSteps = [promoteStep, verifyStep, uploadStep, abortStep, diagnosticsStep, rollbackStep, markerStep];
    expect(orderedSteps.map((step) => productionJob.indexOf(step))).toEqual(
      [...orderedSteps].map((step) => productionJob.indexOf(step)).sort((left, right) => left - right),
    );
    expect(productionJob.indexOf('echo "KUBECONFIG=${kubeconfig}" >> "$GITHUB_ENV"')).toBeLessThan(
      productionJob.indexOf(verifyStep),
    );

    expect(verifyStep).toContain("if: env.SHOULD_DEPLOY != 'false'");
    expect(verifyStep).not.toContain("ARGO_ROLLOUTS_ENABLED == 'true'");
    expect(verifyStep).toContain("verify-deployment-transition");
    expect(verifyStep).toContain('--rollback-target "artifacts/release-health/production-rollback-target.json"');
    expect(verifyStep).toContain('--out "artifacts/release-health/production-kubernetes-deployment-transition.json"');
    expect(verifyStep).not.toMatch(/DIGITALOCEAN_ACCESS_TOKEN|SPACES_ACCESS_ID|SPACES_SECRET_KEY|TF_VAR_/);

    expect(uploadStep).toContain("if: env.SHOULD_DEPLOY != 'false'");
    expect(uploadStep).not.toContain("ARGO_ROLLOUTS_ENABLED == 'true'");
    expect(uploadStep).toContain("uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("name: production-kubernetes-deployment-transition");
    expect(uploadStep).toContain("path: artifacts/release-health/production-kubernetes-deployment-transition.json");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).not.toMatch(/DIGITALOCEAN_ACCESS_TOKEN|SPACES_ACCESS_ID|SPACES_SECRET_KEY|TF_VAR_/);
    expect(releaseHealthUpload).toContain("artifacts/release-health/production-kubernetes-deployment-transition.json");
  });

  it("keeps deployment-transition verification out of staging, rollback, and incident-resolution call sites", () => {
    for (const workflow of [
      platformStagingHelmRecoveryWorkflow,
      platformStagingRollbackDrillWorkflow,
      platformRollbackReadinessWorkflow,
    ]) {
      expect(workflow).not.toContain("verify-deployment-transition");
    }

    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const rollbackStep = workflowStep(productionJob, "Roll back production Kubernetes release");
    expect(rollbackStep).toContain("platform:kubernetes-deployment -- rollback");
    expect(rollbackStep).not.toContain("verify-deployment-transition");

    const incidentJob = workflowJob(platformProductionWorkflow, "close-resolved-deploy-incidents");
    expect(incidentJob).toContain('startswith("Incident: Platform Deploy ")');
    expect(incidentJob).not.toContain("verify-deployment-transition");
  });

  it("runs the database restore drill as a confirmed staging-only monthly workflow", () => {
    const restoreJob = workflowJob(platformDatabaseRestoreDrillWorkflow, "restore-drill");
    const restoreStep = workflowStep(platformDatabaseRestoreDrillWorkflow, "Run staging database restore drill");
    const uploadStep = workflowStep(platformDatabaseRestoreDrillWorkflow, "Upload restore drill evidence");

    expect(platformDatabaseRestoreDrillWorkflow).toContain("Cadence decision (#4029)");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("keep the full restore drill monthly");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("about 29 wall-minutes");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("confirmed manual dispatch");
    expect(platformDatabaseRestoreDrillWorkflow).toContain('cron: "23 7 3 * *"');
    expect(platformDatabaseRestoreDrillWorkflow).toContain("workflow_dispatch:");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("run staging database restore drill");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("permissions:\n  contents: read");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("group: platform-database-restore-drill");
    expect(restoreJob).toContain("environment: staging");
    expect(restoreJob).toContain("timeout-minutes: 90");
    expect(restoreJob).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(platformDatabaseRestoreDrillWorkflow).toContain(
      "digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    );
    expect(restoreStep).toContain("STAGING_DATABASE_CLUSTER_ID");
    expect(restoreStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(restoreStep).toContain("MANAGED_POSTGRES_CA_PATH: ${{ runner.temp }}/digitalocean-managed-postgres-ca.pem");
    expect(restoreStep).toContain("DIGITALOCEAN_DATABASE_RESTORE_DRILL_OUT");
    expect(restoreStep).toContain("node ./scripts/digitalocean-database-restore-drill.mjs");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("- name: Remove managed Postgres CA");
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("platform-database-restore-drill-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(uploadStep).toContain("retention-days: 30");
    expect(platformDatabaseRestoreDrillWorkflow).not.toContain("PRODUCTION_DATABASE_CLUSTER_ID");
    expect(platformDatabaseRestoreDrillWorkflow).not.toContain("DEPLOYMENT_ENVIRONMENT: production");
  });

  it("runs the DOKS Helm rollback drill as a confirmed staging-only workflow", () => {
    const drillJob = workflowJob(platformStagingRollbackDrillWorkflow, "staging-rollback-drill");
    const revisionsStep = workflowStep(platformStagingRollbackDrillWorkflow, "Capture and validate Helm revisions");
    const rollbackStep = workflowStep(platformStagingRollbackDrillWorkflow, "Roll back staging DOKS Helm release");
    const rollForwardStep = workflowStep(
      platformStagingRollbackDrillWorkflow,
      "Roll forward staging DOKS Helm release",
    );
    const uploadStep = workflowStep(platformStagingRollbackDrillWorkflow, "Upload staging rollback drill evidence");

    expect(platformStagingRollbackDrillWorkflow).toContain("workflow_dispatch:");
    expect(platformStagingRollbackDrillWorkflow).toContain("run staging rollback drill");
    expect(platformStagingRollbackDrillWorkflow).toContain("rollback_revision");
    expect(platformStagingRollbackDrillWorkflow).toContain("rollback_reference");
    expect(platformStagingRollbackDrillWorkflow).toContain("permissions:\n  contents: read");
    expect(platformStagingRollbackDrillWorkflow).toContain("group: platform-deploy-staging");
    expect(platformStagingRollbackDrillWorkflow).toContain("cancel-in-progress: false");
    expect(drillJob).toContain("environment: staging");
    expect(drillJob).toContain("timeout-minutes: 60");
    expect(drillJob).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(drillJob).toContain("CHASE_SETS_HELM_RELEASE: chase-sets-platform");
    expect(drillJob).toContain("CHASE_SETS_KUBERNETES_NAMESPACE: chase-sets-platform");
    expect(platformStagingRollbackDrillWorkflow).toContain("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(platformStagingRollbackDrillWorkflow).toContain(
      "digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f",
    );
    expect(platformStagingRollbackDrillWorkflow).toContain("backend-config=key=doks/staging.tfstate");
    expect(revisionsStep).toContain('helm history "$CHASE_SETS_HELM_RELEASE"');
    expect(revisionsStep).toContain("original_revision=${current.revision}");
    expect(rollbackStep).toContain("platform:kubernetes-deployment -- rollback");
    expect(rollbackStep).toContain('--revision "$ROLLBACK_REVISION"');
    expect(rollbackStep).toContain("--runtime-env DEPLOYMENT_ENVIRONMENT=staging");
    expect(rollForwardStep).toContain('--revision "${{ steps.helm_revisions.outputs.original_revision }}"');
    expect(rollForwardStep).toContain("--runtime-env DEPLOYMENT_ENVIRONMENT=staging");
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("platform-staging-rollback-drill-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(uploadStep).toContain("if-no-files-found: error");
    expect(uploadStep).toContain("retention-days: 30");
    expect(platformStagingRollbackDrillWorkflow).toContain("Report staging rollback drill failure");
    expect(platformStagingRollbackDrillWorkflow).toContain("Report staging rollback drill recovery");
    expect(platformStagingRollbackDrillWorkflow).not.toContain("digitalocean-staging-rollback-drill.mjs");
    expect(platformStagingRollbackDrillWorkflow).not.toContain("doctl apps");
    expect(platformStagingRollbackDrillWorkflow).not.toContain("environment: production");
    expect(platformStagingRollbackDrillWorkflow).not.toContain("PRODUCTION_DATABASE_CLUSTER_ID");
  });

  it("runs staging Helm recovery as a confirmed DOKS-only rollback workflow", () => {
    const recoveryJob = workflowJob(platformStagingHelmRecoveryWorkflow, "staging-helm-recovery");
    const kubeconfigStep = workflowStep(platformStagingHelmRecoveryWorkflow, "Configure staging Kubernetes context");
    const preDiagnosticsStep = workflowStep(
      platformStagingHelmRecoveryWorkflow,
      "Capture pre-recovery Helm diagnostics",
    );
    const rollbackStep = workflowStep(platformStagingHelmRecoveryWorkflow, "Roll back staging Helm release");
    const uploadStep = workflowStep(platformStagingHelmRecoveryWorkflow, "Upload staging Helm recovery evidence");

    expect(platformStagingHelmRecoveryWorkflow).toContain("workflow_dispatch:");
    expect(platformStagingHelmRecoveryWorkflow).toContain("recover staging helm release");
    expect(platformStagingHelmRecoveryWorkflow).toContain("rollback_revision");
    expect(platformStagingHelmRecoveryWorkflow).toContain("recovery_reference");
    expect(platformStagingHelmRecoveryWorkflow).toContain("permissions:\n  contents: read");
    expect(platformStagingHelmRecoveryWorkflow).toContain("group: platform-deploy-staging");
    expect(platformStagingHelmRecoveryWorkflow).toContain("cancel-in-progress: false");
    expect(recoveryJob).toContain("environment: staging");
    expect(recoveryJob).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(recoveryJob).toContain("CHASE_SETS_HELM_RELEASE: chase-sets-platform");
    expect(recoveryJob).toContain("CHASE_SETS_KUBERNETES_NAMESPACE: chase-sets-platform");
    expect(recoveryJob).toContain("RECOVERY_REFERENCE: ${{ inputs.recovery_reference }}");
    expect(recoveryJob).toContain("ROLLBACK_REVISION: ${{ inputs.rollback_revision }}");
    expect(kubeconfigStep).toContain("infrastructure/digitalocean/doks");
    expect(kubeconfigStep).toContain("-backend-config=key=doks/staging.tfstate");
    expect(kubeconfigStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(preDiagnosticsStep).toContain('helm status "$CHASE_SETS_HELM_RELEASE"');
    expect(preDiagnosticsStep).toContain("pnpm run platform:kubernetes-deployment -- diagnostics");
    expect(rollbackStep).toContain("pnpm run");
    expect(rollbackStep).toContain("platform:kubernetes-deployment -- rollback");
    expect(rollbackStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(rollbackStep).toContain('--release "$CHASE_SETS_HELM_RELEASE"');
    expect(rollbackStep).toContain("--runtime-env DEPLOYMENT_ENVIRONMENT=staging");
    expect(rollbackStep).toContain('--out "$rollback_record"');
    expect(rollbackStep).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(rollbackStep).toContain('--revision "$ROLLBACK_REVISION"');
    expect(rollbackStep).not.toContain('if [ -n "$ROLLBACK_REVISION" ]');
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("platform-staging-helm-recovery-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(platformStagingHelmRecoveryWorkflow).not.toContain("environment: production");
    expect(platformStagingHelmRecoveryWorkflow).not.toContain("PRODUCTION_DATABASE_CLUSTER_ID");
  });

  it("runs the staging bootstrap hook acceptance drill as a confirmed DOKS-only workflow", () => {
    const drillJob = workflowJob(platformStagingBootstrapHookDrillWorkflow, "staging-bootstrap-hook-drill");
    const kubeconfigStep = workflowStep(
      platformStagingBootstrapHookDrillWorkflow,
      "Configure staging Kubernetes context",
    );
    const smokeDomainsStep = workflowStep(platformStagingBootstrapHookDrillWorkflow, "Resolve staging smoke domains");
    const drillStep = workflowStep(platformStagingBootstrapHookDrillWorkflow, "Run staging bootstrap hook drill");
    const uploadStep = workflowStep(
      platformStagingBootstrapHookDrillWorkflow,
      "Upload staging bootstrap hook drill evidence",
    );

    expect(platformStagingBootstrapHookDrillWorkflow).toContain("workflow_dispatch:");
    expect(platformStagingBootstrapHookDrillWorkflow).toContain("run staging bootstrap hook drill");
    expect(platformStagingBootstrapHookDrillWorkflow).toContain("drill_reference");
    expect(platformStagingBootstrapHookDrillWorkflow).toContain("permissions:\n  contents: read");
    expect(platformStagingBootstrapHookDrillWorkflow).toContain("group: platform-deploy-staging");
    expect(platformStagingBootstrapHookDrillWorkflow).toContain("cancel-in-progress: false");
    expect(drillJob).toContain("environment: staging");
    expect(drillJob).toContain("timeout-minutes: 90");
    expect(drillJob).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(drillJob).toContain("CHASE_SETS_HELM_RELEASE: chase-sets-platform");
    expect(drillJob).toContain("CHASE_SETS_KUBERNETES_NAMESPACE: chase-sets-platform");
    expect(drillJob).toContain("STAGING_BOOTSTRAP_HOOK_DRILL_OUT_DIR: artifacts/staging-bootstrap-hook-drill");
    expect(kubeconfigStep).toContain("infrastructure/digitalocean/doks");
    expect(kubeconfigStep).toContain("-backend-config=key=doks/staging.tfstate");
    expect(smokeDomainsStep).toContain("-backend-config=key=landing/staging.tfstate");
    expect(smokeDomainsStep).toContain("LANDING_URL=https://${landing_domain}");
    expect(smokeDomainsStep).toContain("MARKETPLACE_ROOT_WEB_URL=https://${staging_root_marketplace_domain}");
    expect(drillStep).toContain("node ./scripts/staging-bootstrap-hook-drill.mjs");
    expect(drillStep).toContain('--release "$CHASE_SETS_HELM_RELEASE"');
    expect(drillStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(drillStep).toContain('--out-dir "$STAGING_BOOTSTRAP_HOOK_DRILL_OUT_DIR"');
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain(
      "platform-staging-bootstrap-hook-drill-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(platformStagingBootstrapHookDrillWorkflow).not.toContain("environment: production");
    expect(platformStagingBootstrapHookDrillWorkflow).not.toContain("PRODUCTION_DATABASE_CLUSTER_ID");
  });

  it("documents DOKS staging operations with current Helm release and namespace names", () => {
    expect(doksPlatformOperationsRunbook).toContain("| Helm release | `chase-sets-platform` |");
    expect(doksPlatformOperationsRunbook).toContain("| Namespace | `chase-sets-platform` |");
    expect(doksPlatformOperationsRunbook).toContain("Platform Staging Bootstrap Hook Drill");
    expect(doksPlatformOperationsRunbook).toContain("run staging bootstrap hook drill");
    expect(doksPlatformOperationsRunbook).toContain("held-lock-evidence.json");
    expect(doksPlatformOperationsRunbook).toContain("successful-bootstrap-upgrade");
    expect(doksPlatformOperationsRunbook).not.toContain("--release chase-sets-staging");
    expect(doksPlatformOperationsRunbook).not.toContain("--namespace staging");
  });

  it("runs advisory staging seed and marketplace E2E outside the production promotion gate", () => {
    const deployStagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const deployProductionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const advisoryEvidenceJob = workflowJob(platformStagingAdvisoryEvidenceWorkflow, "staging-advisory-evidence");
    const advisoryNotificationJob = workflowJob(
      platformStagingAdvisoryEvidenceWorkflow,
      "notify-staging-advisory-evidence",
    );
    const advisoryDispatchFailureJob = workflowJob(
      platformProductionWorkflow,
      "notify-staging-advisory-dispatch-failure",
    );
    const advisoryDispatchStep = workflowStep(platformProductionWorkflow, "Dispatch advisory staging evidence");
    const stagingResetRedeployStep = workflowStep(
      platformStagingResetWorkflow,
      "Queue DOKS redeploy after database recreation",
    );
    const stagingPlaywrightVersionStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Resolve Playwright Chromium version",
    );
    const stagingPlaywrightCacheStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Cache Playwright Chromium for staging critical flows",
    );
    const stagingPlaywrightInstallStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Install Playwright Chromium for staging critical flows",
    );
    const stagingCriticalFlowStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Staging marketplace critical flows",
    );
    const stagingScenarioSeedStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Seed staging Kubernetes scenario data",
    );
    const stagingBuyNowProbesStep = workflowStep(platformProductionWorkflow, "Staging Buy Now freshness probes");
    const stagingBlockingProbeEvidenceStep = workflowStep(
      platformProductionWorkflow,
      "Upload staging blocking probe release-health evidence",
    );
    const stagingBuyNowEvidenceStep = workflowStep(platformProductionWorkflow, "Upload staging Buy Now probe evidence");
    const stagingAdvisoryEvidenceUploadStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Upload staging advisory evidence",
    );
    const stagingAccountCartCanaryStep = workflowStep(
      platformProductionWorkflow,
      "Staging account-cart freshness canary",
    );
    const stagingAccountCartCanaryEvidenceStep = workflowStep(
      platformProductionWorkflow,
      "Upload staging account-cart canary evidence",
    );
    const stagingMoneySmokeStep = workflowStep(platformProductionWorkflow, "Staging Stripe money smoke");
    const previewMoneySmokeStep = workflowStep(platformPrWorkflow, "Stripe money smoke");
    const markStagingDeployedIndex = platformProductionWorkflow.indexOf("- name: Mark staging applied");

    expect(deployStagingJob).not.toContain("pnpm run platform:kubernetes-deployment -- scenario-seed");
    expect(deployStagingJob).not.toContain("pnpm run test:e2e:deployed");
    expect(deployProductionJob).not.toContain("staging-advisory-evidence");
    expect(deployProductionJob).toContain("- deploy-staging");
    expect(advisoryDispatchStep).toContain("continue-on-error: true");
    expect(advisoryDispatchStep).toContain("gh workflow run platform-staging-advisory-evidence.yml");
    expect(advisoryDispatchStep).toContain('--field release_commit="$RELEASE_COMMIT"');
    expect(advisoryDispatchStep).toContain('--field platform_image="$PLATFORM_IMAGE"');
    expect(advisoryDispatchStep).toContain('--field platform_image_digest="$PLATFORM_IMAGE_DIGEST"');
    expect(stagingResetRedeployStep).toContain("gh workflow run platform-production.yml");
    expect(stagingResetRedeployStep).toContain("--ref main");
    expect(stagingResetRedeployStep).toContain("-f dispatch_source=recovery");
    expect(deployStagingJob.indexOf("- name: Wait for staging ingress URLs")).toBeLessThan(
      deployStagingJob.indexOf("- name: Dispatch advisory staging evidence"),
    );
    expect(deployStagingJob.indexOf("- name: Dispatch advisory staging evidence")).toBeLessThan(
      deployStagingJob.indexOf("- name: Smoke check"),
    );
    expect(advisoryEvidenceJob).toContain("timeout-minutes: 90");
    expect(advisoryEvidenceJob).toContain("environment: staging");
    expect(platformStagingAdvisoryEvidenceWorkflow).toContain("group: platform-staging-advisory-evidence");
    expect(platformStagingAdvisoryEvidenceWorkflow).toContain("cancel-in-progress: false");
    expect(stagingScenarioSeedStep).toContain("continue-on-error: true");
    expect(stagingScenarioSeedStep).toContain("artifacts/staging-advisory-evidence/scenario-seed.json");
    expect(stagingCriticalFlowStep).toContain("continue-on-error: true");
    expect(advisoryEvidenceJob).toContain("Upload staging advisory evidence");
    expect(advisoryEvidenceJob).toContain("staging-advisory-evidence-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(advisoryEvidenceJob).toContain("Fail scenario-seed advisory signal");
    expect(advisoryEvidenceJob).toContain("Fail marketplace E2E advisory signal");
    expect(advisoryEvidenceJob).toContain('"scenario-seed"');
    expect(advisoryEvidenceJob).toContain('"marketplace-e2e"');
    expect(advisoryEvidenceJob).toContain("failedPhases:$failedPhases");
    expect(stagingAdvisoryEvidenceUploadStep).toContain("if: always()");
    expect(stagingAdvisoryEvidenceUploadStep).not.toContain("if: failure()");
    expect(stagingAdvisoryEvidenceUploadStep).toContain("path: artifacts/staging-advisory-evidence/summary.json");
    expect(stagingAdvisoryEvidenceUploadStep).toContain("if-no-files-found: error");
    expect(stagingAdvisoryEvidenceUploadStep).toContain("retention-days: 30");
    expect(stagingAdvisoryEvidenceUploadStep).not.toContain("artifacts/playwright");
    expect(advisoryEvidenceJob.indexOf("- name: Upload staging advisory evidence")).toBeLessThan(
      advisoryEvidenceJob.indexOf("- name: Fail scenario-seed advisory signal"),
    );
    expect(advisoryNotificationJob).toContain("needs: staging-advisory-evidence");
    expect(advisoryNotificationJob).toContain("issues: write");
    expect(advisoryNotificationJob).toContain("Incident: Staging advisory evidence failing");
    expect(advisoryNotificationJob).toContain("gh issue comment");
    expect(advisoryNotificationJob).toContain("gh issue close");
    expect(advisoryDispatchFailureJob).toContain("needs: deploy-staging");
    expect(advisoryDispatchFailureJob).toContain("issues: write");
    expect(advisoryDispatchFailureJob).toContain("advisory_dispatch_result == 'failure'");
    expect(advisoryDispatchFailureJob).not.toContain("deploy-production");

    expect(stagingPlaywrightVersionStep).toContain("id: staging-playwright-chromium");
    expect(stagingPlaywrightVersionStep).toContain("pnpm exec playwright --version");
    expect(stagingPlaywrightVersionStep).toContain('echo "version=${version}" >> "$GITHUB_OUTPUT"');
    expect(stagingPlaywrightCacheStep).toContain(
      "uses: actions/cache@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0",
    );
    expect(stagingPlaywrightCacheStep).toContain("id: staging-playwright-chromium-cache");
    expect(stagingPlaywrightCacheStep).toContain("path: /home/runner/.cache/ms-playwright");
    expect(stagingPlaywrightCacheStep).toContain(
      "key: playwright-chromium-${{ runner.os }}-${{ steps.staging-playwright-chromium.outputs.version }}",
    );
    expect(stagingPlaywrightCacheStep).toContain("playwright-chromium-${{ runner.os }}-");
    expect(stagingPlaywrightInstallStep).not.toContain("cache-hit != 'true'");
    expect(stagingPlaywrightInstallStep).toContain("PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright");
    expect(stagingPlaywrightInstallStep).toContain("pnpm exec playwright install --with-deps chromium");
    expect(platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Resolve Playwright Chromium version")).toBeLessThan(
      platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Cache Playwright Chromium for staging critical flows"),
    );
    expect(
      platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Cache Playwright Chromium for staging critical flows"),
    ).toBeLessThan(
      platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Install Playwright Chromium for staging critical flows"),
    );
    expect(
      platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Install Playwright Chromium for staging critical flows"),
    ).toBeLessThan(platformStagingAdvisoryEvidenceWorkflow.indexOf("- name: Staging marketplace critical flows"));
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_SKIP_WEB_SERVER");
    expect(stagingCriticalFlowStep).toContain("continue-on-error: true");
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright");
    expect(stagingCriticalFlowStep).toContain('admin_domain="$(terraform output -raw admin_domain)"');
    expect(stagingCriticalFlowStep).toContain('ADMIN_WEB_URL="https://${admin_domain}"');
    expect(stagingCriticalFlowStep).toContain('MARKETPLACE_WEB_URL="https://${marketplace_domain}"');
    expect(stagingCriticalFlowStep).toContain("pnpm run test:e2e:deployed");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_EMAIL");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_PASSWORD");
    expect(stagingCriticalFlowStep).toContain("PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL || '' }}");
    expect(stagingCriticalFlowStep).toContain("PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD || '' }}");
    expect(stagingCriticalFlowStep).toContain("for name in PLATFORM_ADMIN_EMAIL PLATFORM_ADMIN_PASSWORD");
    expect(stagingCriticalFlowStep).toContain(
      "credentials-not-threaded: staging marketplace E2E missing required trust inputs",
    );
    expect(stagingCriticalFlowStep).toContain("CATALOG_ADMIN_E2E_EMAIL");
    expect(stagingCriticalFlowStep).toContain("CATALOG_ADMIN_E2E_PASSWORD");
    expect(stagingCriticalFlowStep).toContain("vars.MARKETPLACE_E2E_EMAIL || ''");
    expect(stagingCriticalFlowStep).toContain("secrets.MARKETPLACE_E2E_PASSWORD || ''");
    expect(stagingCriticalFlowStep).toContain("vars.CATALOG_ADMIN_E2E_EMAIL || ''");
    expect(stagingCriticalFlowStep).toContain("secrets.CATALOG_ADMIN_E2E_PASSWORD || ''");
    expect(stagingCriticalFlowStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingCriticalFlowStep).toContain("AWS_SECRET_ACCESS_KEY");

    // The deployed advisory run covers three hosts. /privacy is a Public
    // Presence route contributed to the public-web deployable only, so the
    // landing domain has to be resolved from the same exact-release Terraform
    // state and threaded as PUBLIC_WEB_URL; without it the public-web project
    // is absent and the coverage disappears silently.
    expect(stagingCriticalFlowStep).toContain('landing_domain="$(terraform output -raw landing_domain)"');
    expect(stagingCriticalFlowStep).toContain('PUBLIC_WEB_URL="https://${landing_domain}"');
    expect(stagingCriticalFlowStep).toContain('[ -z "$landing_domain" ]');
    expect(stagingCriticalFlowStep).toContain(
      "Required staging admin, marketplace, or landing domain was not present in Terraform outputs.",
    );
    expect(stagingMoneySmokeStep).not.toContain("continue-on-error");
    expect(platformStagingAdvisoryEvidenceWorkflow).toContain("staging-advisory-evidence");
    expect(stagingBuyNowProbesStep).toContain("GUEST_BUY_NOW_PROBE_SEARCH_QUERY");
    expect(stagingBuyNowProbesStep).toContain("PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright");
    expect(stagingBuyNowProbesStep).toContain("vars.STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY");
    expect(stagingBuyNowProbesStep).toContain("'air balloon'");
    expect(stagingBuyNowProbesStep).not.toContain("vars.MARKETPLACE_E2E_SEARCH_QUERY");
    expect(stagingBuyNowProbesStep).toContain("--search-query");
    expect(stagingBuyNowProbesStep).toContain("GUEST_BUY_NOW_PROBE_ITEM_PATH");
    expect(stagingBuyNowProbesStep).toContain('common_args+=(--item-path "${GUEST_BUY_NOW_PROBE_ITEM_PATH}")');
    expect(stagingBuyNowProbesStep).toContain('admin_domain="$(terraform output -raw admin_domain)"');
    expect(stagingBuyNowProbesStep).toContain("--admin-base-url");
    expect(stagingBuyNowProbesStep).toContain("PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL }}");
    expect(stagingBuyNowProbesStep).toContain("PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD }}");
    expect(stagingBuyNowProbesStep).toContain("pnpm run guest-buy-now:freshness-probe");
    expect(stagingBuyNowProbesStep).toContain(
      "GUEST_BUY_NOW_PROBE_READY_SLO_MS: ${{ vars.STAGING_GUEST_BUY_NOW_CANARY_READY_SLO_MS || '10000' }}",
    );
    expect(stagingBuyNowProbesStep).toContain(
      "GUEST_BUY_NOW_PROBE_ATTEMPTS: ${{ vars.STAGING_GUEST_BUY_NOW_CANARY_ATTEMPTS || '3' }}",
    );
    expect(stagingBuyNowProbesStep).toContain(
      "GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_BUDGET_MS: ${{ vars.STAGING_GUEST_BUY_NOW_WAKE_RUNTIME_READY_BUDGET_MS || '120000' }}",
    );
    expect(stagingBuyNowProbesStep).toContain(
      "GUEST_BUY_NOW_PROBE_WAKE_RUNTIME_READY_POLL_INTERVAL_MS: ${{ vars.STAGING_GUEST_BUY_NOW_WAKE_RUNTIME_READY_POLL_INTERVAL_MS || '5000' }}",
    );
    expect(stagingBuyNowProbesStep).toContain("--ready-slo-ms");
    expect(stagingBuyNowProbesStep).toContain("--attempts");
    expect(stagingBuyNowProbesStep).toContain("--wake-runtime-ready-budget-ms");
    expect(stagingBuyNowProbesStep).toContain("--wake-runtime-ready-poll-interval-ms");
    expect(stagingBuyNowProbesStep).toContain("--flow guest");
    expect(stagingBuyNowProbesStep).toContain("--flow account");
    expect(stagingBuyNowProbesStep).toContain("artifacts/release-health/guest-buy-now-freshness-probe.json");
    expect(stagingBuyNowProbesStep).toContain("artifacts/release-health/account-buy-now-freshness-probe.json");
    expect(stagingBlockingProbeEvidenceStep).toContain("if: failure()");
    expect(stagingBlockingProbeEvidenceStep).toContain("name: staging-blocking-probe-playwright-artifacts");
    expect(stagingBlockingProbeEvidenceStep).toContain("artifacts/release-health/guest-buy-now-freshness-probe.json");
    expect(stagingBlockingProbeEvidenceStep).toContain("artifacts/release-health/account-buy-now-freshness-probe.json");
    expect(stagingBlockingProbeEvidenceStep).not.toContain("artifacts/playwright");
    expect(stagingBuyNowProbesStep).toContain("guest_failure_reason=");
    expect(stagingBuyNowProbesStep).toContain("account_failure_reason=");
    expect(stagingBuyNowProbesStep).toContain(
      'echo "| Flow | Final state | Promotion decision | Failure reason | Ready latency (ms) | Correlation id |"',
    );
    expect(stagingBuyNowProbesStep).not.toContain("MARKETPLACE_E2E_EMAIL");
    expect(stagingBuyNowProbesStep).not.toContain("MARKETPLACE_E2E_PASSWORD");
    expect(stagingBuyNowProbesStep).toContain("--flow account");
    expect(stagingBuyNowProbesStep).toContain("PLATFORM_ADMIN_EMAIL");
    expect(stagingBuyNowEvidenceStep).toContain(
      "if: always() && env.SHOULD_DEPLOY != 'false' && steps.buy_now_probes.conclusion != 'skipped'",
    );
    expect(stagingBuyNowEvidenceStep).toContain("staging-buy-now-freshness-probes");
    expect(stagingBuyNowEvidenceStep).toContain("artifacts/release-health/account-buy-now-freshness-probe.json");
    expect(platformProductionWorkflow).toContain("buy_now_probe_result: ${{ steps.buy_now_probes.outputs.result }}");
    expect(platformProductionWorkflow).toContain(
      "buy_now_probe_guest_failure_reason: ${{ steps.buy_now_probes.outputs.guest_failure_reason }}",
    );
    expect(platformProductionWorkflow).toContain(
      "buy_now_probe_account_failure_reason: ${{ steps.buy_now_probes.outputs.account_failure_reason }}",
    );
    expect(platformProductionWorkflow).toContain(
      "CANARY_RESULT: ${{ needs.deploy-staging.outputs.buy_now_probe_result || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "CANARY_PROMOTION_DECISION: ${{ needs.deploy-staging.outputs.buy_now_probe_promotion_decision || 'skipped' }}",
    );

    // #2516: account-cart-post-write-consistency promoted to a required
    // migrated canary. It blocks staging promotion when a redacted
    // observation is configured (STAGING_ACCOUNT_CART_CANARY_OBSERVATION_JSON)
    // and the probe does not promote; otherwise it records an explicit
    // warning instead of a silent pass.
    expect(stagingAccountCartCanaryStep).toContain("id: account_cart_canary");
    expect(stagingAccountCartCanaryStep).toContain(
      "ACCOUNT_CART_CANARY_OBSERVATION_JSON: ${{ vars.STAGING_ACCOUNT_CART_CANARY_OBSERVATION_JSON || '' }}",
    );
    expect(stagingAccountCartCanaryStep).toContain("pnpm run ops account-cart:consistency-probe");
    expect(stagingAccountCartCanaryStep).toContain("--observation-file");
    expect(stagingAccountCartCanaryStep).toContain('echo "configured=false"');
    expect(stagingAccountCartCanaryStep).toContain('echo "configured=true"');
    expect(stagingAccountCartCanaryStep).toContain('echo "promotion_decision=not-configured"');
    expect(stagingAccountCartCanaryStep).toContain(
      "Staging account-cart freshness canary aborted promotion (exit ${probe_exit}).",
    );
    expect(stagingAccountCartCanaryEvidenceStep).toContain(
      "if: always() && env.SHOULD_DEPLOY != 'false' && steps.account_cart_canary.outputs.configured == 'true'",
    );
    expect(stagingAccountCartCanaryEvidenceStep).toContain("staging-account-cart-freshness-canary");
    expect(platformProductionWorkflow).toContain(
      "account_cart_canary_result: ${{ steps.account_cart_canary.outputs.result || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "account_cart_canary_promotion_decision: ${{ steps.account_cart_canary.outputs.promotion_decision || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "account_cart_canary_configured: ${{ steps.account_cart_canary.outputs.configured || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "ACCOUNT_CART_CANARY_RESULT: ${{ needs.deploy-staging.outputs.account_cart_canary_result || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "ACCOUNT_CART_CANARY_PROMOTION_DECISION: ${{ needs.deploy-staging.outputs.account_cart_canary_promotion_decision || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "ACCOUNT_CART_CANARY_CONFIGURED: ${{ needs.deploy-staging.outputs.account_cart_canary_configured || 'false' }}",
    );

    expect(stagingMoneySmokeStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingMoneySmokeStep).toContain("AWS_SECRET_ACCESS_KEY");
    expect(stagingMoneySmokeStep).toContain("SMOKE_REGISTER_SELLER");
    expect(stagingMoneySmokeStep).toContain(
      "SMOKE_SELLER_DISPLAY_NAME: Stripe Staging Smoke ${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(stagingMoneySmokeStep).toContain(
      "SMOKE_INVITATION_PROJECTION_TIMEOUT_MS: ${{ vars.STAGING_STRIPE_MONEY_SMOKE_INVITATION_PROJECTION_TIMEOUT_MS || '300000' }}",
    );
    expect(stagingMoneySmokeStep).toContain(
      "PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL || env.TF_VAR_platform_admin_email || '' }}",
    );
    expect(stagingMoneySmokeStep).toContain(
      "PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD || env.TF_VAR_platform_admin_password || '' }}",
    );
    expect(stagingMoneySmokeStep).not.toContain("STRIPE_CONNECT_RETURN_URL");
    expect(stagingMoneySmokeStep).not.toContain("STRIPE_CONNECT_REFRESH_URL");
    expect(stagingMoneySmokeStep).toContain("STRIPE_MONEY_SMOKE_ENVIRONMENT: staging");
    expect(stagingMoneySmokeStep).toContain('STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS: "false"');
    expect(stagingMoneySmokeStep).not.toContain("STAGING_STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE");
    expect(stagingMoneySmokeStep).not.toContain("STAGING_STRIPE_PAYMENT_WEBHOOK_DELIVERY_EVENT_ID");
    expect(stagingMoneySmokeStep).not.toContain("STAGING_STRIPE_CONNECT_WEBHOOK_DELIVERY_EVENT_ID");
    expect(stagingMoneySmokeStep).toContain("STAGING_SMOKE_ORDER_IDS");
    expect(stagingMoneySmokeStep).toContain('PLATFORM_API_BASE_URL="https://${marketplace_domain}"');
    expect(stagingMoneySmokeStep).toContain("pnpm run stripe:money-smoke -- --edge-check --seller-flow");

    expect(platformProductionWorkflow).toContain("Staging requires dedicated Stripe test-mode keys");
    expect(platformProductionWorkflow).not.toContain("STAGING_STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE");
    expect(platformProductionWorkflow).not.toContain("STAGING_STRIPE_PAYMENT_WEBHOOK_DELIVERY_EVENT_ID");
    expect(platformProductionWorkflow).not.toContain("STAGING_STRIPE_CONNECT_WEBHOOK_DELIVERY_EVENT_ID");
    expect(platformPrWorkflow).toContain("Preview deployments require Stripe test-mode keys.");
    expect(previewMoneySmokeStep).toContain("SMOKE_REGISTER_SELLER");
    // The Kubernetes preview job no longer exports TF_VAR_platform_admin_* at
    // job scope, so the money smoke reads admin credentials straight from
    // repository secrets instead of falling back through Terraform variables.
    expect(previewMoneySmokeStep).toContain("PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL }}");
    expect(previewMoneySmokeStep).toContain("PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD }}");
    expect(previewMoneySmokeStep).toContain("STRIPE_MONEY_SMOKE_ENVIRONMENT: preview");
    expect(previewMoneySmokeStep).toContain(
      "SMOKE_INVITATION_PROJECTION_TIMEOUT_MS: ${{ vars.PREVIEW_STRIPE_MONEY_SMOKE_INVITATION_PROJECTION_TIMEOUT_MS || '300000' }}",
    );
    expect(previewMoneySmokeStep).toContain('STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS: "false"');
    expect(previewMoneySmokeStep).toContain("pnpm run stripe:money-smoke -- --edge-check --seller-flow");

    expect(platformProductionWorkflow).not.toContain("- name: Staging marketplace critical flows");
    expect(platformProductionWorkflow).not.toContain("- name: Seed staging Kubernetes scenario data");
    expect(platformStagingAdvisoryEvidenceWorkflow).toContain("- name: Staging marketplace critical flows");
    expect(platformStagingAdvisoryEvidenceWorkflow).toContain("- name: Seed staging Kubernetes scenario data");
    expect(platformProductionWorkflow.indexOf("- name: Staging Buy Now freshness probes")).toBeLessThan(
      markStagingDeployedIndex,
    );
    expect(platformProductionWorkflow.indexOf("- name: Staging Stripe money smoke")).toBeLessThan(
      markStagingDeployedIndex,
    );
  });

  it("binds each deployed Playwright project to its own host and never crosses deployables", () => {
    // Each project's testMatch is anchored to exactly one deployable's e2e tree,
    // and each baseURL comes from that deployable's own URL input. The failure
    // this pins is a spec answered by a host that does not serve its route: the
    // deployed run then asserts against another deployable's not-found shell.
    expect(playwrightConfig).toContain('name: "marketplace-chromium"');
    expect(playwrightConfig).toContain('testMatch: "deployables/marketplace/e2e/**/*.spec.ts"');
    expect(playwrightConfig).toContain("baseURL: marketplaceBaseUrl");
    expect(playwrightConfig).toContain('name: "admin-web-chromium"');
    expect(playwrightConfig).toContain('testMatch: "deployables/admin-web/e2e/**/*.spec.ts"');
    expect(playwrightConfig).toContain("baseURL: adminWebBaseUrl");
    expect(playwrightConfig).toContain('name: "public-web-chromium"');
    expect(playwrightConfig).toContain('testMatch: "deployables/public-web/e2e/**/*.spec.ts"');
    expect(playwrightConfig).toContain("baseURL: publicWebBaseUrl");
    expect(playwrightConfig).toContain(
      "const publicWebBaseUrl = process.env.PUBLIC_WEB_URL ?? sandbox.urls.publicWeb;",
    );
    expect(playwrightConfig).toContain("const includePublicWebProject = Boolean(process.env.PUBLIC_WEB_URL);");

    // Negative control: no project may widen its testMatch across deployables,
    // which is how the public-web privacy spec previously answered on the
    // marketplace host.
    const projectTestMatches = [...playwrightConfig.matchAll(/testMatch: "([^"]+)"/g)].map(([, pattern]) => pattern);
    expect(projectTestMatches).toEqual([
      "deployables/marketplace/e2e/**/*.spec.ts",
      "deployables/admin-web/e2e/**/*.spec.ts",
      "deployables/public-web/e2e/**/*.spec.ts",
    ]);
    expect(playwrightConfig).not.toContain("deployables/*/e2e");
    expect(playwrightConfig).not.toContain("deployables/**/e2e");

    // The deployed advisory lane is the only caller that names all three hosts.
    const stagingCriticalFlowStep = workflowStep(
      platformStagingAdvisoryEvidenceWorkflow,
      "Staging marketplace critical flows",
    );
    expect(stagingCriticalFlowStep).toContain(
      'ADMIN_WEB_URL="https://${admin_domain}" MARKETPLACE_WEB_URL="https://${marketplace_domain}" PUBLIC_WEB_URL="https://${landing_domain}" pnpm run test:e2e:deployed',
    );
  });

  it("scopes every staging Buy Now convergence gate to checkout.session-projection and publishes its evidence", () => {
    const deployGateStep = workflowStep(platformProductionWorkflow, "Await staging projection convergence");
    const routeMatrixGateStep = workflowStep(
      platformStagingRouteMatrixEvidenceWorkflow,
      "Await staging projection convergence",
    );
    const evidenceUploadStep = workflowStep(platformProductionWorkflow, "Upload staging Buy Now probe evidence");
    const scopedDefault =
      "PROJECTION_CONVERGENCE_PROJECTION_NAMES: ${{ vars.STAGING_PROJECTION_CONVERGENCE_PROJECTION_NAMES || 'checkout.session-projection' }}";

    expect(deployGateStep).toContain(scopedDefault);
    expect(routeMatrixGateStep).toContain(scopedDefault);
    expect(deployGateStep).toContain('--convergence-projection-names "${PROJECTION_CONVERGENCE_PROJECTION_NAMES}"');
    expect(routeMatrixGateStep).toContain(
      '--convergence-projection-names "${PROJECTION_CONVERGENCE_PROJECTION_NAMES}"',
    );
    const truthfulConvergenceSummary =
      'if .gate.converged == null then "unknown" else (.gate.converged | tostring) end';
    expect(deployGateStep).toContain(truthfulConvergenceSummary);
    expect(routeMatrixGateStep).toContain(truthfulConvergenceSummary);
    expect(deployGateStep).not.toContain('.gate.converged // "unknown"');
    expect(routeMatrixGateStep).not.toContain('.gate.converged // "unknown"');
    expect(deployGateStep).not.toContain(
      "PROJECTION_CONVERGENCE_PROJECTION_NAMES: ${{ vars.STAGING_PROJECTION_CONVERGENCE_PROJECTION_NAMES || 'all' }}",
    );
    expect(routeMatrixGateStep).not.toContain(
      "PROJECTION_CONVERGENCE_PROJECTION_NAMES: ${{ vars.STAGING_PROJECTION_CONVERGENCE_PROJECTION_NAMES || 'all' }}",
    );
    expect(evidenceUploadStep).toContain("artifacts/release-health/staging-projection-convergence-gate.json");
    expect(platformProductionWorkflow.indexOf("- name: Await staging projection convergence")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Staging Buy Now freshness probes"),
    );
  });
});

describe("Release qualification evidence root (issue #5836)", () => {
  const rootDir = "infrastructure/digitalocean/release-qualification";
  const rqMain = readFileSync(resolve(`${rootDir}/main.tf`), "utf8");
  const rqVersions = readFileSync(resolve(`${rootDir}/versions.tf`), "utf8");
  const rqVariables = readFileSync(resolve(`${rootDir}/variables.tf`), "utf8");
  const rqOutputs = readFileSync(resolve(`${rootDir}/outputs.tf`), "utf8");
  const rqBackendExample = readFileSync(resolve(`${rootDir}/backend.hcl.example`), "utf8");
  const rqReadme = readFileSync(resolve(`${rootDir}/README.md`), "utf8");
  const rqAllTf = [rqMain, rqVersions, rqVariables, rqOutputs].join("\n");

  it("creates only the dedicated private evidence Space and nothing else (cost wager)", () => {
    const resources = rqAllTf.match(/^resource "/gm) ?? [];
    expect(resources).toHaveLength(1);
    expect(rqMain).toContain('resource "digitalocean_spaces_bucket" "release_qualification"');
    expect(rqVariables).toContain('default = "chase-sets-release-qualification"');
    expect(rqMain).toContain('acl    = "private"');
    expect(rqAllTf).not.toMatch(/digitalocean_spaces_bucket_object|digitalocean_cdn|digitalocean_project/);
  });

  it("requires versioning, destroy protection, and the 400-day evidence-retention lifecycle", () => {
    expect(rqMain).toMatch(/versioning\s*{\s*enabled = true\s*}/);
    expect(rqMain).toContain("force_destroy = false");
    expect(rqMain).toMatch(/lifecycle\s*{\s*prevent_destroy = true\s*}/);

    const expirationDays = [...rqMain.matchAll(/^\s+days = (\d+)$/gm)].map((match) => Number(match[1]));
    expect(expirationDays).toHaveLength(2);
    for (const days of expirationDays) {
      expect(days).toBeGreaterThanOrEqual(400);
    }
    expect(rqMain).toContain("noncurrent_version_expiration");
  });

  it("uses the shared remote-state backend at a DEDICATED key, never the state-bootstrap pattern", () => {
    expect(rqVersions).toContain('backend "s3" {}');
    expect(rqBackendExample).toContain('key                         = "release-qualification/shared.tfstate"');
    expect(rqBackendExample).toContain('bucket                      = "chase-sets-terraform-state"');

    // The intentionally local-state bootstrap root stays evidence-only: it
    // must not grow a second bucket or any release-qualification wiring.
    expect(stateBootstrapMain).not.toContain("release");
    expect((stateBootstrapMain.match(/^resource "/gm) ?? []).length).toBe(1);
  });

  it("documents the runtime/terraform credential split and the record contract ownership", () => {
    expect(rqVariables).toMatch(/RELEASE_EVIDENCE_SPACES_\*/);
    expect(rqReadme).toContain("RELEASE_EVIDENCE_SPACES_ACCESS_ID");
    expect(rqReadme).toContain("RELEASE_EVIDENCE_SPACES_SECRET_KEY");
    expect(rqReadme).toContain("merge-gate");
    expect(rqReadme).toContain("production");
    expect(rqReadme).toContain("scripts/release-qualification-record.mjs");
    expect(rqReadme).toContain("docs/runbooks/release-qualification-evidence.md");
  });

  it("keeps qualification records out of the Terraform-state bucket at runtime", () => {
    // Records live in the dedicated Space; only this root's *state* uses the
    // shared state bucket. The record CLI must default to the dedicated Space.
    const recordScript = readFileSync(resolve("scripts/release-qualification-record.mjs"), "utf8");
    expect(recordScript).toContain('RELEASE_QUALIFICATION_EVIDENCE_BUCKET = "chase-sets-release-qualification"');
    expect(recordScript).not.toContain('"chase-sets-terraform-state"');
  });
});

describe("Seed Pack storage root (issue #5874)", () => {
  const rootDir = "infrastructure/digitalocean/seed-packs";
  const seedMain = readFileSync(resolve(`${rootDir}/main.tf`), "utf8");
  const seedVersions = readFileSync(resolve(`${rootDir}/versions.tf`), "utf8");
  const seedVariables = readFileSync(resolve(`${rootDir}/variables.tf`), "utf8");
  const seedOutputs = readFileSync(resolve(`${rootDir}/outputs.tf`), "utf8");
  const seedBackendExample = readFileSync(resolve(`${rootDir}/backend.hcl.example`), "utf8");
  const seedReadme = readFileSync(resolve(`${rootDir}/README.md`), "utf8");
  const seedRunbook = readFileSync(resolve("docs/runbooks/seed-pack-storage.md"), "utf8");
  const seedWorkflow = readFileSync(resolve(".github/workflows/platform-seed-packs-apply.yml"), "utf8");
  const stateSnapshotScript = readFileSync(resolve("scripts/digitalocean-terraform-state-snapshot.mjs"), "utf8");
  const seedAllTf = [seedMain, seedVersions, seedVariables, seedOutputs].join("\n");

  it("owns exactly the approved private versioned Space and two bucket-scoped keys", () => {
    expect(seedAllTf.match(/^resource "/gm) ?? []).toHaveLength(3);
    expect(seedVariables).toContain('default = "cs-dev-seed-packs"');
    expect(seedMain).toMatch(/resource "digitalocean_spaces_bucket" "seed_packs"/);
    expect(seedMain).toContain('acl    = "private"');
    expect(seedMain).toMatch(/versioning\s*{\s*enabled = true\s*}/);
    expect(seedMain).toContain("force_destroy = false");
    expect(seedMain).toMatch(/lifecycle\s*{\s*prevent_destroy = true\s*}/);
    expect(seedAllTf).not.toMatch(/digitalocean_cdn|digitalocean_spaces_bucket_policy|public-read/);

    const keys = seedMain.match(/resource "digitalocean_spaces_key" "(?:dev|ci)"/g) ?? [];
    expect(keys).toHaveLength(2);
    expect(seedMain.match(/bucket\s+= digitalocean_spaces_bucket\.seed_packs\.name/g)).toHaveLength(2);
    expect(seedMain.match(/permission\s+= "readwrite"/g)).toHaveLength(2);
    expect(seedMain).not.toContain("fullaccess");
  });

  it("retains accepted current objects and expires deleted payload versions within 30 days", () => {
    expect(seedMain).toMatch(/expiration\s*{\s*expired_object_delete_marker = true\s*}/);
    expect(seedMain).toMatch(/noncurrent_version_expiration\s*{\s*days = 30\s*}/);
    expect(seedMain).not.toMatch(/^\s*expiration\s*{\s*days\s*=/m);
    expect(seedMain).toContain("abort_incomplete_multipart_upload_days = 7");
    expect(seedReadme).toContain("Accepted packs have no age-based expiration");
    expect(seedRunbook).toContain("within 30 days");
  });

  it("uses the sibling shared-state convention and registers the durable state key", () => {
    expect(seedVersions).toContain('backend "s3" {}');
    expect(seedVersions).toContain('source  = "digitalocean/digitalocean"');
    expect(seedVersions).toContain('version = "~> 2.85"');
    expect(seedBackendExample).toContain('bucket                      = "chase-sets-terraform-state"');
    expect(seedBackendExample).toContain('key                         = "seed-packs/shared.tfstate"');
    expect(stateSnapshotScript).toContain('"seed-packs/shared.tfstate"');
  });

  it("keeps key material sensitive and names both operator destinations", () => {
    for (const output of [
      "dev_spaces_access_id",
      "dev_spaces_secret_key",
      "ci_spaces_access_id",
      "ci_spaces_secret_key",
    ]) {
      expect(seedOutputs).toMatch(new RegExp(`output "${output}" \\{[\\s\\S]*?sensitive = true[\\s\\S]*?\\}`));
    }
    expect(seedRunbook).toContain("SEED_PACKS_SPACES_ACCESS_ID");
    expect(seedRunbook).toContain("SEED_PACKS_SPACES_SECRET_KEY");
    expect(seedRunbook).toContain("`preview` and `merge-gate`");
    expect(seedRunbook).toContain("Do not add them to `staging` or `production`");
  });

  it("binds the reviewed encrypted plan payload to apply and wires live privacy/isolation probes", () => {
    expect(seedWorkflow).toContain('plan -out="$binary_plan"');
    expect(seedWorkflow).toContain('apply -auto-approve "$decrypted_plan"');
    expect(seedWorkflow).toContain("reviewed_plan_run_id:");
    expect(seedWorkflow).toContain("reviewed_plan_run_attempt:");
    expect(seedWorkflow).toContain("reviewed_plan_artifact_digest:");
    expect(seedWorkflow).toContain("scripts/terraform-reviewed-plan.mjs seal");
    expect(seedWorkflow).toContain("scripts/terraform-reviewed-plan.mjs verify-source");
    expect(seedWorkflow).toContain("scripts/terraform-reviewed-plan.mjs open");
    expect(seedWorkflow).toContain("probe_key dev dev_spaces_access_id dev_spaces_secret_key");
    expect(seedWorkflow).toContain("probe_key ci ci_spaces_access_id ci_spaces_secret_key");
    expect(seedWorkflow).toContain('status" != "403"');
    expect(seedWorkflow).toContain("--bucket chase-sets-terraform-state");
    expect(seedWorkflow).toContain('grep -qi "AccessDenied"');
    expect(seedRunbook).toContain("terraform apply -replace=digitalocean_spaces_key.dev");
    expect(seedRunbook).toContain("terraform apply -replace=digitalocean_spaces_key.ci");
    expect(seedRunbook).toContain("aws s3api delete-objects");
    expect(seedRunbook).toContain("Post the terminal operator evidence on #5951 and cross-link it from #5874");
  });
});
