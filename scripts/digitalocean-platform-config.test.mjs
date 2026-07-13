import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_WEB_API_DEPENDENCIES } from "./admin-shell-smoke-matrix.mjs";
import { listContextManifests } from "./lib/repo.mjs";

const platformMain = readFileSync(resolve("infrastructure/digitalocean/platform/main.tf"), "utf8");
const platformLocals = readFileSync(resolve("infrastructure/digitalocean/platform/locals.tf"), "utf8");
const platformOutputs = readFileSync(resolve("infrastructure/digitalocean/platform/outputs.tf"), "utf8");
const platformVariables = readFileSync(resolve("infrastructure/digitalocean/platform/variables.tf"), "utf8");
const platformRuntimeValues = readFileSync(resolve("infrastructure/helm/platform/runtime-values.json"), "utf8");
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
const platformProductionWorkflow = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");
const platformPrWorkflow = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");
const platformCoverageWorkflow = readFileSync(resolve(".github/workflows/platform-coverage.yml"), "utf8");
const platformDoksFoundationWorkflow = readFileSync(resolve(".github/workflows/platform-doks-foundation.yml"), "utf8");
const platformObservabilityStateMigrationWorkflow = readFileSync(
  resolve(".github/workflows/platform-observability-state-migration.yml"),
  "utf8",
);
const platformKubernetesDeploymentScript = readFileSync(resolve("scripts/platform-kubernetes-deployment.mjs"), "utf8");
const renderPlatformHelmValuesScript = readFileSync(resolve("scripts/render-platform-helm-values.mjs"), "utf8");
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
const sourceContextWakeRegistry = readFileSync(
  resolve("infrastructure/platform-runtime/source-context-wake-registry.ts"),
  "utf8",
);
const adminWebViteConfig = readFileSync(resolve("deployables/admin-web/vite.config.ts"), "utf8");

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
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
    expect(digitaloceanPlatformRunbook).toContain("managed Postgres, context databases and pools");
    expect(digitaloceanPlatformRunbook).toContain("Database Operations");

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

function workflowJob(source, jobName) {
  const match = new RegExp(`(^|\\n)  ${jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).exec(source);
  expect(match).not.toBeNull();

  const start = match.index + match[1].length;
  const rest = source.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
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

describe("DigitalOcean platform configuration", () => {
  it("keeps staging landing under the environment namespace and redirects the legacy dash host", () => {
    expect(platformLocals).toContain('local.is_staging ? "www.${var.environment}.${var.root_domain}"');
    expect(platformLocals).not.toContain('local.is_staging ? "${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain('"landing-${var.environment}.${var.root_domain}"');
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

  it("keeps Catalog asset wiring available to the DOKS runtime", () => {
    for (const key of [
      "CATALOG_ASSET_STORAGE_KIND",
      "CATALOG_ASSET_S3_BUCKET",
      "CATALOG_ASSET_S3_REGION",
      "CATALOG_ASSET_S3_ENDPOINT",
      "CATALOG_ASSET_PUBLIC_BASE_URL",
      "CATALOG_ASSET_S3_ACCESS_KEY_ID",
      "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(platformRuntimeValues).toContain(`"${key}"`);
    }

    expect(platformLocals).toContain("catalog_asset_s3_endpoint");
    expect(platformLocals).toContain("catalog_asset_public_base_url");
    expect(platformOutputs).toContain('output "catalog_asset_public_base_url"');
    expect(platformOutputs).toContain('output "catalog_asset_s3_bucket"');
    expect(platformOutputs).toContain('output "catalog_asset_s3_endpoint"');
    expect(platformOutputs).toContain('output "catalog_asset_s3_region"');
    expect(platformVariables).not.toContain('variable "catalog_asset_s3_bucket"');
    expect(platformVariables).not.toContain('variable "catalog_asset_public_base_url"');
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

  it("reaps production restore-point forks on a six-hour cleanup window", () => {
    expect(platformProductionRestorePointCleanupWorkflow).toContain('cron: "17 3,9,15,21 * * *"');
    expect(platformProductionRestorePointCleanupWorkflow).toContain('default: "6"');
    expect(platformProductionRestorePointCleanupWorkflow).toContain(
      `min_age_hours="\${{ github.event.inputs.min_age_hours || '6' }}"`,
    );
    expect(platformProductionRestorePointCleanupWorkflow).toContain("PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES");
  });

  it("keeps shared Catalog provider runtime keys in the Kubernetes-owned values", () => {
    for (const key of [
      "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
      "SCRYDEX_API_KEY",
      "SCRYDEX_TEAM_ID",
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES",
    ]) {
      expect(platformRuntimeValues).toContain(`"${key}"`);
    }
    expect(platformRuntimeValues).not.toContain("SCRYDEX_ONE_PIECE_API_KEY");
    expect(platformRuntimeValues).not.toContain("SCRYDEX_ONE_PIECE_TEAM_ID");
    expect(platformRuntimeValues).not.toMatch(/TCGAuthTicket|SCRYDEX_API_KEY\s*:\s*"[^"]+"/);
  });

  it("keeps staging smoke under active auth registration rate limits", () => {
    expect(platformRuntimeValues).toContain('"CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX"');
    expect(platformRuntimeValues).toContain('"value": "30"');
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
    expect(platformStagingResetWorkflow).toContain("doctl compute domain records list chasesets.com --output json");
    expect(platformStagingResetWorkflow).toContain("Catalog asset CDN root must stay protected; expected 403");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("repair catalog-assets cdn state");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("doctl compute cdn list --output json");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("terraform state rm digitalocean_cdn.catalog_assets");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("terraform import digitalocean_cdn.catalog_assets");
    expect(platformCatalogAssetsStateRepairWorkflow).toContain("Terraform state points at an existing CDN");
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

  it("routes UCP agent discovery and transport paths to platform-api", () => {
    expect(renderPlatformHelmValuesScript).toContain('"/.well-known"');
    expect(renderPlatformHelmValuesScript).toContain('"/ucp"');
  });

  it("routes native MCP transport paths to platform-api", () => {
    expect(renderPlatformHelmValuesScript).toContain('"/mcp"');
  });

  it("wires Google Workspace SSO into the DOKS runtime", () => {
    expect(platformRuntimeValues).toContain('"GOOGLE_SOCIAL_LOGIN_CLIENT_ID"');
    expect(platformRuntimeValues).toContain('"GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"');
    expect(platformRuntimeValues).toContain('"ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"');
  });

  it("provisions dedicated least-privilege wake-listener users with same-apply grants", () => {
    const grantScript = readFileSync(resolve("scripts/apply-digitalocean-database-grant.mjs"), "utf8");

    // Dedicated listener users exist in staging and production only.
    expect(platformMain).toContain('resource "digitalocean_database_user" "wake_listeners"');
    expect(platformMain).toContain("for_each   = local.wake_listener_database_users");
    expect(platformLocals).toContain("wake_listener_database_users = (local.is_production || local.is_staging) ? {");

    // Grants run inside the same Terraform apply that rotates the DOKS runtime
    // database URLs.
    expect(platformMain).toContain('resource "terraform_data" "wake_listener_database_grants"');
    expect(platformMain).toContain("count = length(local.wake_listener_grant_contexts) > 0 ? 1 : 0");
    expect(platformMain).toContain(
      '"${digitalocean_database_db.contexts[context_name].id}:${digitalocean_database_user.wake_listeners[context_name].id}"',
    );
    expect(platformMain).toContain('kind     = "wake-listener"');
    expect(platformMain).toContain("user     = digitalocean_database_user.wake_listeners[context_name].name");
    // The grant script understands the wake-listener kind and grants only
    // CONNECT + schema USAGE + event-store SELECT for it.
    expect(grantScript).toContain('GRANT_KINDS = Object.freeze(["owner", "wake-listener"])');
    expect(grantScript).toContain(
      'WAKE_LISTENER_EVENT_STORE_TABLES = Object.freeze(["event_store_events", "event_store_streams"])',
    );
    expect(grantScript).toContain("GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${userIdentifier}");
    expect(grantScript).toContain("GRANT USAGE ON SCHEMA public TO ${userIdentifier}");
    expect(grantScript).toContain("to_regclass");

    // Plan-time least-privilege gate: listener URLs must embed the dedicated
    // wake-listener users.
    expect(platformMain).toContain('check "wake_listener_least_privilege"');
    expect(platformMain).toContain(
      '"//${urlencode(lookup(local.wake_listener_database_users, context_name, "missing-wake-listener-user"))}:",',
    );
    expect(platformMain).toContain(
      'error_message = "Relay listener URLs must use the dedicated wake-listener database users (LISTEN + read-only event-store access), never the owning context users."',
    );
  });

  it("waits for post-deploy projection readiness before production smoke asserts", () => {
    const exportStep = workflowStep(platformProductionWorkflow, "Export production readiness database URLs");
    const readinessStep = workflowStep(platformProductionWorkflow, "Production post-deploy readiness gate");

    // Ordering: before the smoke check and Stage 1 canary, so projection-
    // dependent production smoke assertions measure steady state (#4012).
    const smokeIndex = platformProductionWorkflow.lastIndexOf("- name: Smoke check");
    const exportIndex = platformProductionWorkflow.indexOf("- name: Export production readiness database URLs");
    const readinessIndex = platformProductionWorkflow.indexOf("- name: Production post-deploy readiness gate");
    const stage1Index = platformProductionWorkflow.indexOf("- name: Stage 1 production canary");
    expect(exportIndex).toBeLessThan(readinessIndex);
    expect(readinessIndex).toBeLessThan(smokeIndex);
    expect(readinessIndex).toBeLessThan(stage1Index);

    // The export step derives direct production URLs from Terraform state
    // (staging wake-drills pattern) and masks them.
    expect(exportStep).toContain("terraform state pull");
    expect(exportStep).toContain("digitalocean_database_cluster");
    expect(exportStep).toContain("::add-mask::");
    expect(exportStep).toContain("PLATFORM_CONTROL_DATABASE_URL");
    expect(exportStep).toContain('[...readinessContexts, "checkout", "public-presence", "control"]');
    expect(exportStep).toContain(
      "READINESS_GATE_SOURCE_CONTEXTS: ${{ vars.PRODUCTION_READINESS_GATE_SOURCE_CONTEXTS || 'checkout,public-presence' }}",
    );
    expect(exportStep).toContain("if: env.SHOULD_DEPLOY != 'false'");
    expect(exportStep).not.toContain("vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true'");
    expect(exportStep).toContain("continue-on-error: true");

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

  it("captures rollback readiness before production cutover and rolls back failed post-cutover checks", () => {
    const deployProductionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const deployStagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const stagingSmokeStep = workflowSteps(deployStagingJob, "Smoke check").at(-1);
    const productionSmokeStep = workflowSteps(deployProductionJob, "Smoke check").at(-1);
    const stagingKubeconfigStep = workflowStep(deployStagingJob, "Configure staging Kubernetes context");
    const stagingDatabaseUrlsStep = workflowStep(deployStagingJob, "Export staging Kubernetes database URLs");
    const stagingRuntimeSecretsStep = workflowStep(deployStagingJob, "Apply staging Kubernetes runtime secrets");
    const stagingRegistryPullSecretStep = workflowStep(
      deployStagingJob,
      "Apply staging Kubernetes registry pull secret",
    );
    const stagingDeployStep = workflowStep(deployStagingJob, "Deploy staging Kubernetes release");
    const stagingDiagnosticsStep = workflowStep(deployStagingJob, "Capture staging Kubernetes deploy diagnostics");
    const stagingIngressWaitStep = workflowStep(deployStagingJob, "Wait for staging ingress URLs");
    const kubeconfigStep = workflowStep(deployProductionJob, "Configure production Kubernetes context");
    const captureStep = workflowStep(deployProductionJob, "Capture production rollback target");
    const readinessStep = workflowStep(deployProductionJob, "Evaluate production rollback readiness");
    const runtimeSecretsStep = workflowStep(deployProductionJob, "Apply production Kubernetes runtime secrets");
    const registryPullSecretStep = workflowStep(
      deployProductionJob,
      "Apply production Kubernetes registry pull secret",
    );
    const deployStep = workflowStep(deployProductionJob, "Deploy production Kubernetes release");
    const productionKubernetesDiagnosticsUpload = workflowStep(
      deployProductionJob,
      "Upload production Kubernetes deploy diagnostics",
    );
    const diagnosticsStep = workflowStep(deployProductionJob, "Capture post-cutover production Kubernetes diagnostics");
    const rollbackStep = workflowStep(deployProductionJob, "Roll back production Kubernetes release");
    const releaseHealthStep = workflowSteps(platformProductionWorkflow, "Write release health summary").at(-1);
    const uploadStep = workflowSteps(platformProductionWorkflow, "Upload release health summary").at(-1);

    expect(deployStagingJob).not.toContain("- name: Capture production rollback target");
    expect(deployStagingJob).not.toContain("- name: Evaluate production rollback readiness");
    expect(deployStagingJob).not.toContain("digitalocean-app-deployment.mjs");
    expect(stagingSmokeStep).toContain("timeout-minutes: 12");
    expect(stagingSmokeStep).toContain('SMOKE_FETCH_TIMEOUT_MS: "15000"');
    expect(productionSmokeStep).toContain("timeout-minutes: 15");
    expect(productionSmokeStep).toContain('SMOKE_FETCH_TIMEOUT_MS: "15000"');

    const stagingApplyIndex = deployStagingJob.indexOf("- name: Terraform apply");
    const stagingKubeconfigIndex = deployStagingJob.indexOf("- name: Configure staging Kubernetes context");
    const stagingRuntimeSecretsIndex = deployStagingJob.indexOf("- name: Apply staging Kubernetes runtime secrets");
    const stagingRegistryPullSecretIndex = deployStagingJob.indexOf(
      "- name: Apply staging Kubernetes registry pull secret",
    );
    const stagingDeployIndex = deployStagingJob.indexOf("- name: Deploy staging Kubernetes release");
    const stagingIngressWaitIndex = deployStagingJob.indexOf("- name: Wait for staging ingress URLs");
    const stagingPromoteIndex = deployStagingJob.indexOf("- name: Promote staging Argo Rollouts");
    const stagingAbortIndex = deployStagingJob.indexOf("- name: Abort staging Argo Rollouts");
    const stagingAppliedIndex = deployStagingJob.indexOf("- name: Mark staging applied");
    const captureIndex = deployProductionJob.indexOf("- name: Capture production rollback target");
    const readinessIndex = deployProductionJob.indexOf("- name: Evaluate production rollback readiness");
    const applyIndex = deployProductionJob.indexOf("- name: Terraform apply", readinessIndex);
    const runtimeSecretsIndex = deployProductionJob.indexOf("- name: Apply production Kubernetes runtime secrets");
    const registryPullSecretIndex = deployProductionJob.indexOf(
      "- name: Apply production Kubernetes registry pull secret",
    );
    const deployIndex = deployProductionJob.indexOf("- name: Deploy production Kubernetes release");
    const smokeIndex = deployProductionJob.lastIndexOf("- name: Smoke check");
    const stage1Index = deployProductionJob.indexOf("- name: Stage 1 production canary");
    const productionPromoteIndex = deployProductionJob.indexOf("- name: Promote production Argo Rollouts");
    const productionAbortIndex = deployProductionJob.indexOf("- name: Abort production Argo Rollouts");
    const diagnosticsIndex = deployProductionJob.indexOf(
      "- name: Capture post-cutover production Kubernetes diagnostics",
    );
    const rollbackIndex = deployProductionJob.indexOf("- name: Roll back production Kubernetes release");
    const markerIndex = deployProductionJob.indexOf("- name: Mark production release");

    expect(stagingApplyIndex).toBeLessThan(stagingKubeconfigIndex);
    expect(stagingKubeconfigIndex).toBeLessThan(stagingRuntimeSecretsIndex);
    expect(stagingRuntimeSecretsIndex).toBeLessThan(stagingRegistryPullSecretIndex);
    expect(stagingRegistryPullSecretIndex).toBeLessThan(stagingDeployIndex);
    expect(stagingDeployIndex).toBeLessThan(stagingIngressWaitIndex);
    expect(stagingIngressWaitIndex).toBeLessThan(stagingPromoteIndex);
    expect(stagingPromoteIndex).toBeLessThan(stagingAbortIndex);
    expect(stagingAbortIndex).toBeLessThan(stagingAppliedIndex);
    expect(captureIndex).toBeLessThan(readinessIndex);
    expect(readinessIndex).toBeLessThan(applyIndex);
    expect(applyIndex).toBeLessThan(runtimeSecretsIndex);
    expect(runtimeSecretsIndex).toBeLessThan(registryPullSecretIndex);
    expect(registryPullSecretIndex).toBeLessThan(deployIndex);
    expect(deployIndex).toBeLessThan(smokeIndex);
    expect(smokeIndex).toBeLessThan(rollbackIndex);
    expect(stage1Index).toBeLessThan(diagnosticsIndex);
    expect(stage1Index).toBeLessThan(productionPromoteIndex);
    expect(productionPromoteIndex).toBeLessThan(productionAbortIndex);
    expect(productionAbortIndex).toBeLessThan(diagnosticsIndex);
    expect(diagnosticsIndex).toBeLessThan(rollbackIndex);
    expect(rollbackIndex).toBeLessThan(markerIndex);
    expect(deployStagingJob).toContain("STAGING_ARGO_ROLLOUTS_ENABLED");
    expect(deployProductionJob).toContain("PRODUCTION_ARGO_ROLLOUTS_ENABLED");
    expect(platformProductionWorkflow).toContain("kubectl-argo-rollouts-linux-amd64");
    expect(platformProductionWorkflow).toContain("d1c98f59f6d3716b7a35aa540506764700a358448dd6a10e92381b7aa294d00b");

    expect(kubeconfigStep).toContain("infrastructure/digitalocean/doks");
    expect(kubeconfigStep).toContain("-backend-config=key=doks/production.tfstate");
    expect(kubeconfigStep).toContain("terraform output -raw kubeconfig");
    expect(kubeconfigStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(kubeconfigStep).toContain("Terraform DOKS kubeconfig output did not contain a usable current-context");
    expect(kubeconfigStep).toContain('cluster_id="$(terraform output -raw cluster_id');
    expect(kubeconfigStep).toContain('cluster_name="$(terraform output -raw cluster_name');
    expect(kubeconfigStep).toContain("terraform state list");
    expect(kubeconfigStep).toContain(`awk '/(^|\\.)digitalocean_kubernetes_cluster\\./ { print; exit }'`);
    expect(kubeconfigStep).toContain("Using production DOKS cluster Terraform state address");
    expect(kubeconfigStep).toContain(`terraform state show -no-color "$cluster_address"`);
    expect(kubeconfigStep).toContain(`key == "id"`);
    expect(kubeconfigStep).toContain(`key == "name"`);
    expect(kubeconfigStep).toContain('doctl kubernetes cluster kubeconfig show "$cluster_id"');
    expect(kubeconfigStep).toContain('doctl kubernetes cluster kubeconfig show "$cluster_name"');
    expect(kubeconfigStep).toContain("Production Kubernetes kubeconfig is present but has no current context");
    expect(kubeconfigStep).toContain("KUBECONFIG=");
    expect(kubeconfigStep).toContain("Configured production Kubernetes context: ${current_context}");
    expect(captureStep).toContain("git fetch origin production --tags");
    expect(captureStep).toContain("last_known_good_commit");
    expect(captureStep).toContain("capture-rollback-target");
    expect(captureStep).toContain("platform-kubernetes-deployment.mjs");
    expect(captureStep).toContain("production-rollback-target.json");
    expect(captureStep).toContain("docker buildx imagetools inspect");
    expect(captureStep).toContain("smoke_verified=true");

    expect(readinessStep).toContain(
      "ROLLBACK_READINESS_OUT: artifacts/release-health/production-rollback-readiness.json",
    );
    expect(readinessStep).toContain("RECOVERY_MODE: rollback");
    expect(readinessStep).toContain(
      "ROLLBACK_TARGET_COMMIT: ${{ steps.rollback_target.outputs.last_known_good_commit }}",
    );
    expect(readinessStep).toContain("ROLLBACK_IMAGE_REF: ${{ steps.rollback_target.outputs.rollback_image_ref }}");
    expect(readinessStep).toContain("pnpm run rollback:readiness");
    expect(readinessStep).toContain('echo "result=${result}" >> "$GITHUB_OUTPUT"');

    expect(stagingKubeconfigStep).toContain("infrastructure/digitalocean/doks");
    expect(stagingKubeconfigStep).toContain("-backend-config=key=doks/staging.tfstate");
    expect(stagingKubeconfigStep).toContain("terraform output -raw kubeconfig");
    expect(stagingKubeconfigStep).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(stagingKubeconfigStep).toContain("Configured staging Kubernetes context: ${current_context}");
    expect(stagingKubeconfigStep).toContain("Using staging DOKS cluster Terraform state address");
    expect(stagingDatabaseUrlsStep).toContain("node ./scripts/platform-kubernetes-secret.mjs");
    expect(stagingDatabaseUrlsStep).toContain('--export-database-urls "$state_path"');
    expect(stagingDatabaseUrlsStep).toContain("--database-environment staging");
    expect(stagingDatabaseUrlsStep).toContain("--query-connection-mode pooled");
    expect(stagingRuntimeSecretsStep).toContain("node ./scripts/platform-kubernetes-secret.mjs");
    expect(stagingRuntimeSecretsStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(stagingRegistryPullSecretStep).toContain("doctl registry get --format Name --no-header");
    expect(stagingRegistryPullSecretStep).toContain("doctl registry docker-config --expiry-seconds 3600");
    expect(stagingRegistryPullSecretStep).toContain('kubectl create secret generic "$registry_pull_secret_name"');
    expect(stagingDeployStep).toContain("pnpm run platform:kubernetes-deployment -- deploy");
    expect(stagingDeployStep).toContain(
      "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}",
    );
    expect(stagingDeployStep).toContain("Staging catalog asset runtime env outputs are required");
    expect(stagingDeployStep).toContain("AWS_ACCESS_KEY_ID: ${{ secrets.SPACES_ACCESS_ID }}");
    expect(stagingDeployStep).toContain("AWS_SECRET_ACCESS_KEY: ${{ secrets.SPACES_SECRET_KEY }}");
    expect(stagingDeployStep).toContain('--image-pull-secret "$CHASE_SETS_IMAGE_PULL_SECRET_NAME"');
    expect(stagingDeployStep).toContain('--runtime-env "DEPLOYMENT_ENVIRONMENT=staging"');
    expect(platformHelmStagingValues).toContain('generatedBy: "node ./scripts/render-platform-helm-values.mjs"');
    expect(platformHelmStagingValues).toContain("platform-worker:");
    expect(platformHelmStagingValues).toContain('DATABASE_POOL_MAX: "12"');
    expect(platformHelmStagingValues).toContain('WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS: "4"');
    expect(platformHelmStagingValues).toContain('WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "3"');
    expect(platformHelmStagingValues).toContain('WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT: "2"');
    expect(platformHelmStagingValues).toContain("autoscaling:");
    expect(platformHelmStagingValues).toContain("enabled: true");
    expect(platformHelmStagingValues).toContain("minReplicaCount: 1");
    expect(platformHelmStagingValues).toContain("maxReplicaCount: 4");
    expect(platformHelmStagingValues).toContain('connectionFromEnv: "PLATFORM_WORK_SIGNAL_DATABASE_URL"');
    expect(platformHelmStagingValues).toContain("platform_projection_wake_intents");
    expect(platformHelmStagingValues).toContain("state IN ('queued', 'failed')");
    expect(platformRuntimeValues).toContain('"PLATFORM_WORK_SIGNAL_DATABASE_URL"');
    expect(platformHelmStagingValues).not.toContain("WORKER_PROJECTION_OPERATION_RUNNER_COUNT");
    expect(stagingDeployStep).toContain('--runtime-env "CHASE_SETS_RUNTIME_PROFILE=public"');
    expect(stagingDeployStep).toContain(
      '--runtime-env "PLATFORM_DATA_PROFILES=critical-bootstrap,catalog-integration-bootstrap"',
    );
    // Regression guard for the staging admin host 404ing before Google OAuth:
    // the canonical Helm default is empty, so the deploy must thread the
    // environment-specific hosted-domain value explicitly.
    expect(stagingDeployStep).toContain(
      '--runtime-env "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS=${ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS:-}"',
    );
    expect(stagingDeployStep).toContain(
      '--runtime-env "CATALOG_ASSET_PUBLIC_BASE_URL=${catalog_asset_public_base_url}"',
    );
    expect(stagingDeployStep).toContain('--runtime-env "CATALOG_ASSET_S3_BUCKET=${catalog_asset_s3_bucket}"');
    expect(stagingDeployStep).toContain('--runtime-env "CATALOG_ASSET_S3_ENDPOINT=${catalog_asset_s3_endpoint}"');
    expect(stagingDeployStep).toContain('--runtime-env "CATALOG_ASSET_S3_REGION=${catalog_asset_s3_region}"');
    // The canonical Helm values use safe empty/noop defaults, so the deploy
    // must thread environment-specific origins and provider configuration.
    expect(stagingDeployStep).toContain(
      "terraform -chdir=infrastructure/digitalocean/platform output -raw landing_domain",
    );
    expect(stagingDeployStep).toContain('--runtime-env "CHASE_SETS_PUBLIC_ORIGIN=https://${landing_domain}"');
    expect(stagingDeployStep).toContain(
      '--runtime-env "NOTIFICATION_EMAIL_PROVIDER=${TF_VAR_notification_email_provider:-noop}"',
    );
    expect(stagingDeployStep).toContain(
      '--runtime-env "STRIPE_CONNECT_ACCOUNTS_API=${STRIPE_CONNECT_ACCOUNTS_API:-v2}"',
    );
    expect(stagingDeployStep).toContain('--runtime-env "EASYPOST_MODE=${EASYPOST_MODE:-test}"');
    expect(stagingDeployStep).toContain(
      'add_optional_runtime_env "CHASE_SETS_MARKETPLACE_ORIGIN" "${marketplace_domain:+https://${marketplace_domain}}"',
    );
    expect(stagingDeployStep).toContain('add_optional_runtime_env "SES_AWS_REGION" "${TF_VAR_ses_aws_region:-}"');
    expect(stagingDeployStep).toContain('add_optional_runtime_env "SES_FROM_EMAIL" "${TF_VAR_ses_from_email:-}"');
    expect(stagingDeployStep).toContain(
      'add_optional_runtime_env "SES_CONFIGURATION_SET_NAME" "${TF_VAR_ses_configuration_set_name:-}"',
    );
    expect(stagingDeployStep).toContain('add_optional_runtime_env "STRIPE_API_BASE_URL" "${STRIPE_API_BASE_URL:-}"');
    expect(stagingDeployStep).toContain(
      'add_optional_runtime_env "EASYPOST_API_BASE_URL" "${EASYPOST_API_BASE_URL:-}"',
    );
    expect(stagingDeployStep).toContain('"${optional_runtime_env[@]}"');
    expect(stagingDeployStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(stagingDeployStep).toContain('--release "$CHASE_SETS_HELM_RELEASE"');
    expect(stagingDiagnosticsStep).toContain("pnpm run platform:kubernetes-deployment -- diagnostics");
    expect(stagingDiagnosticsStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(stagingIngressWaitStep).toContain("node ./scripts/platform-ingress-wait.mjs");
    expect(stagingIngressWaitStep).toContain('"https://${landing_domain}/health/ready"');
    expect(stagingIngressWaitStep).toContain('"https://${admin_domain}/health/ready"');
    expect(stagingIngressWaitStep).toContain('"https://${hostname}/health/ready"');
    expect(stagingIngressWaitStep).toContain('"https://${hostname}/"');
    expect(stagingIngressWaitStep).toContain("--attempts 60");
    expect(stagingIngressWaitStep).toContain("--delay-ms 30000");

    expect(runtimeSecretsStep).toContain("node ./scripts/platform-kubernetes-secret.mjs");
    expect(runtimeSecretsStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');

    expect(registryPullSecretStep).toContain("doctl registry get --format Name --no-header");
    expect(registryPullSecretStep).toContain("doctl registry docker-config --expiry-seconds 3600");
    expect(registryPullSecretStep).toContain('kubectl create secret generic "$registry_pull_secret_name"');
    expect(registryPullSecretStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(registryPullSecretStep).toContain('--from-file=.dockerconfigjson="$docker_config"');
    expect(registryPullSecretStep).toContain("--type=kubernetes.io/dockerconfigjson");
    expect(registryPullSecretStep).toContain('echo "CHASE_SETS_IMAGE_PULL_SECRET_NAME=${registry_pull_secret_name}"');

    expect(deployStep).toContain("pnpm run platform:kubernetes-deployment -- deploy");
    expect(deployStep).toContain(
      "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}",
    );
    expect(deployStep).toContain("AWS_ACCESS_KEY_ID: ${{ secrets.SPACES_ACCESS_ID }}");
    expect(deployStep).toContain("AWS_SECRET_ACCESS_KEY: ${{ secrets.SPACES_SECRET_KEY }}");
    expect(deployStep).toContain(
      "terraform -chdir=infrastructure/digitalocean/platform output -raw catalog_asset_public_base_url",
    );
    expect(deployStep).toContain(
      "terraform -chdir=infrastructure/digitalocean/platform output -raw catalog_asset_s3_bucket",
    );
    expect(deployStep).toContain(
      "terraform -chdir=infrastructure/digitalocean/platform output -raw catalog_asset_s3_endpoint",
    );
    expect(deployStep).toContain(
      "terraform -chdir=infrastructure/digitalocean/platform output -raw catalog_asset_s3_region",
    );
    expect(deployStep).toContain("Production catalog asset runtime env outputs are required");
    expect(deployStep).toContain('--image-pull-secret "$CHASE_SETS_IMAGE_PULL_SECRET_NAME"');
    expect(deployStep).toContain('--runtime-env "DEPLOYMENT_ENVIRONMENT=production"');
    expect(deployStep).toContain(
      '--runtime-env "CHASE_SETS_RUNTIME_PROFILE=${TF_VAR_production_runtime_profile:-landing}"',
    );
    expect(deployStep).toContain(
      '--runtime-env "PLATFORM_DATA_PROFILES=critical-bootstrap,catalog-integration-bootstrap"',
    );
    expect(deployStep).toContain(
      '--runtime-env "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS=${ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS:-}"',
    );
    expect(deployStep).toContain('--runtime-env "CATALOG_ASSET_PUBLIC_BASE_URL=${catalog_asset_public_base_url}"');
    expect(deployStep).toContain('--runtime-env "CATALOG_ASSET_S3_BUCKET=${catalog_asset_s3_bucket}"');
    expect(deployStep).toContain('--runtime-env "CATALOG_ASSET_S3_ENDPOINT=${catalog_asset_s3_endpoint}"');
    expect(deployStep).toContain('--runtime-env "CATALOG_ASSET_S3_REGION=${catalog_asset_s3_region}"');
    // Production uses the same explicit runtime contract as staging and preview.
    expect(deployStep).toContain("terraform -chdir=infrastructure/digitalocean/platform output -raw landing_domain");
    expect(deployStep).toContain('--runtime-env "CHASE_SETS_PUBLIC_ORIGIN=https://${landing_domain}"');
    expect(deployStep).toContain(
      '--runtime-env "NOTIFICATION_EMAIL_PROVIDER=${TF_VAR_notification_email_provider:-noop}"',
    );
    expect(deployStep).toContain('--runtime-env "STRIPE_CONNECT_ACCOUNTS_API=${STRIPE_CONNECT_ACCOUNTS_API:-v2}"');
    expect(deployStep).toContain('--runtime-env "EASYPOST_MODE=${EASYPOST_MODE:-test}"');
    expect(deployStep).toContain(
      'add_optional_runtime_env "CHASE_SETS_MARKETPLACE_ORIGIN" "${marketplace_domain:+https://${marketplace_domain}}"',
    );
    expect(deployStep).toContain('add_optional_runtime_env "SES_AWS_REGION" "${TF_VAR_ses_aws_region:-}"');
    expect(deployStep).toContain('add_optional_runtime_env "SES_FROM_EMAIL" "${TF_VAR_ses_from_email:-}"');
    expect(deployStep).toContain(
      'add_optional_runtime_env "SES_CONFIGURATION_SET_NAME" "${TF_VAR_ses_configuration_set_name:-}"',
    );
    expect(deployStep).toContain('add_optional_runtime_env "STRIPE_API_BASE_URL" "${STRIPE_API_BASE_URL:-}"');
    expect(deployStep).toContain('add_optional_runtime_env "EASYPOST_API_BASE_URL" "${EASYPOST_API_BASE_URL:-}"');
    expect(deployStep).toContain('"${optional_runtime_env[@]}"');
    expect(deployStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');
    expect(deployStep).toContain('--release "$CHASE_SETS_HELM_RELEASE"');

    expect(productionKubernetesDiagnosticsUpload).toContain("name: production-kubernetes-deploy-diagnostics");

    expect(diagnosticsStep).toContain("if: failure() && env.SHOULD_DEPLOY != 'false'");
    expect(diagnosticsStep).toContain("pnpm run platform:kubernetes-deployment -- diagnostics");
    expect(diagnosticsStep).toContain('--namespace "$CHASE_SETS_KUBERNETES_NAMESPACE"');

    expect(rollbackStep).toContain(
      "if: failure() && env.SHOULD_DEPLOY != 'false' && steps.rollback_readiness.outputs.result == 'success'",
    );
    expect(rollbackStep).toContain("pnpm run platform:kubernetes-deployment -- rollback");
    expect(rollbackStep).toContain('--release "$CHASE_SETS_HELM_RELEASE"');
    expect(rollbackStep).toContain('--out "$rollback_record"');
    expect(rollbackStep).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(rollbackStep).toContain('rollback_result="$(jq -r');
    expect(rollbackStep).toContain('echo "result=${rollback_result}"');
    expect(rollbackStep).toContain("automated-production-rollback");
    expect(rollbackStep).toContain("Automated production rollback failed");
    expect(rollbackStep).toContain('echo "rollback_target_commit=${rollback_target_commit}"');
    expect(rollbackStep).toContain("rollback_command_exit");

    expect(releaseHealthStep).toContain(
      "RECOVERY_MODE: ${{ steps.production_rollback.outputs.result == 'success' && 'rollback'",
    );
    expect(releaseHealthStep).toContain(
      "RECOVERY_TARGET_COMMIT: ${{ steps.production_rollback.outputs.rollback_target_commit || '' }}",
    );
    expect(releaseHealthStep).toContain(
      "ROLLBACK_READINESS_RESULT: ${{ env.SHOULD_DEPLOY == 'false' && 'skipped' || steps.rollback_readiness.outputs.result || 'failure' }}",
    );
    expect(releaseHealthStep).not.toContain("ROLLBACK_READINESS_RESULT: unknown");
    expect(uploadStep).toContain("artifacts/release-health/production-rollback-target.json");
    expect(uploadStep).toContain("artifacts/release-health/production-rollback-readiness.json");
    expect(uploadStep).toContain("artifacts/release-health/production-rollback.json");
    const rollbackIncidentJob = workflowJob(platformProductionWorkflow, "notify-production-rollback-incident");
    expect(rollbackIncidentJob).toContain("production-deploy-rollback-failure");
    expect(rollbackIncidentJob).toContain("Attempted rollback target commit");
    expect(rollbackIncidentJob).toContain("This issue is intentionally separate from the primary deploy failure");
    expect(rollbackIncidentJob).toContain("needs.deploy-production.outputs.rollback_result == 'failure'");
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
    const platformContexts = terraformStringList(platformLocals, "platform_context_names");

    expect(landingContexts).not.toContain("checkout");
    expect(landingContexts).not.toContain("payments");
    expect(platformContexts).toEqual(expect.arrayContaining(["checkout", "payments", "settlement"]));
    expect(platformLocals).toContain(
      "active_runtime_context_names = local.platform_enabled ? local.platform_context_names : local.landing_context_names",
    );
    expect(platformLocals).toContain("exposed_route_context_names  = local.active_runtime_context_names");
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

  it("keeps production marketplace promotion explicitly gated", () => {
    expect(platformVariables).toContain('variable "production_marketplace_public_enabled"');
    expect(platformVariables).toContain("production_marketplace_public_enabled may only be true for production.");
    expect(platformVariables).toContain('variable "production_runtime_profile"');
    expect(platformVariables).toContain("production_runtime_profile must be landing, proof, or public.");
    expect(platformVariables).not.toContain('variable "production_marketplace_launch_evidence_reference"');
    expect(platformVariables).not.toContain('variable "production_marketplace_proof_enabled"');
    expect(platformVariables).not.toContain('variable "production_marketplace_proof_reference"');
    expect(platformVariables).toContain('variable "production_marketplace_promotion_approved"');
    expect(platformVariables).toContain("production_marketplace_promotion_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_marketplace_promotion_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_promotion_reference is required when production_marketplace_promotion_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_marketplace_checkout_fee_approved"');
    expect(platformVariables).toContain(
      "production_marketplace_checkout_fee_approved may only be true for production.",
    );
    expect(platformVariables).toContain('variable "production_marketplace_checkout_fee_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_checkout_fee_reference is required when production_marketplace_checkout_fee_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_checkout_launch_evidence_approved"');
    expect(platformVariables).toContain(
      "production_checkout_launch_evidence_approved may only be true for production.",
    );
    expect(platformVariables).toContain('variable "production_checkout_launch_evidence_reference"');
    expect(platformVariables).toContain(
      "production_checkout_launch_evidence_reference is required when production_checkout_launch_evidence_approved is true.",
    );
    expect(platformRuntimeValues).toContain('"CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE"');
    expect(platformVariables).toContain('variable "production_stripe_money_operations_approved"');
    expect(platformVariables).toContain("production_stripe_money_operations_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_stripe_money_operations_reference"');
    expect(platformVariables).toContain(
      "production_stripe_money_operations_reference is required when production_stripe_money_operations_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_support_operations_approved"');
    expect(platformVariables).toContain("production_support_operations_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_support_operations_reference"');
    expect(platformVariables).toContain(
      "production_support_operations_reference is required when production_support_operations_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_fulfillment_postage_approved"');
    expect(platformVariables).toContain("production_fulfillment_postage_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_fulfillment_postage_reference"');
    expect(platformVariables).toContain(
      "production_fulfillment_postage_reference is required when production_fulfillment_postage_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_transactional_email_approved"');
    expect(platformVariables).toContain("production_transactional_email_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_transactional_email_reference"');
    expect(platformVariables).toContain(
      "production_transactional_email_reference is required when production_transactional_email_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_launch_supply_measurements_approved"');
    expect(platformVariables).toContain(
      "production_launch_supply_measurements_approved may only be true for production.",
    );
    expect(platformVariables).toContain('variable "production_launch_supply_measurements_reference"');
    expect(platformVariables).toContain(
      "production_launch_supply_measurements_reference is required when production_launch_supply_measurements_approved is true.",
    );
    expect(platformVariables).toContain('variable "production_tax_readiness_approved"');
    expect(platformVariables).toContain("production_tax_readiness_approved may only be true for production.");
    expect(platformVariables).toContain('variable "production_tax_readiness_reference"');
    expect(platformVariables).toContain(
      "production_tax_readiness_reference is required when production_tax_readiness_approved is true.",
    );
    expect(platformVariables).toContain('var.production_runtime_profile == "landing"');
    expect(platformRuntimeValues).toContain('"STRIPE_CONNECT_WEBHOOK_SECRET"');
    expect(platformRuntimeValues).toContain('"STRIPE_CONNECT_ACCOUNTS_API"');
    expect(platformRuntimeValues).toContain('"EASYPOST_WEBHOOK_SECRET"');
    expect(platformRuntimeValues).not.toContain('"STRIPE_CONNECT_RETURN_URL"');
    expect(platformRuntimeValues).not.toContain('"STRIPE_CONNECT_REFRESH_URL"');
    expect(platformLocals).toContain("platform_enabled = (");
    expect(platformLocals).toContain('local.runtime_profile != "landing"');
    expect(platformLocals).toContain("placeholder_evidence_references = [");
    expect(platformLocals).toContain('"launch-000"');
    expect(platformLocals).not.toContain("var.production_marketplace_proof_enabled");
    expect(platformLocals).toContain(
      'runtime_profile = local.is_non_production ? "public" : var.production_runtime_profile',
    );
    expect(platformLocals).toContain("marketplace_public_enabled = (");
    expect(platformLocals).toContain('local.is_non_production || local.runtime_profile == "public"');
    expect(platformLocals).not.toContain("production_proof_web_enabled");
    expect(platformLocals).toContain("marketplace_domains = local.marketplace_public_enabled");
    expect(platformLocals).toContain('local.is_production ? "marketplace.${var.root_domain}"');
    expect(renderPlatformHelmValuesScript).toContain('"/api/payments/provider/webhooks"');
    expect(renderPlatformHelmValuesScript).toContain('"/api/settlement/provider/money-movement/webhooks"');
    expect(platformLocals).not.toContain("proof_api_ingress_routes");
    expect(platformLocals).not.toContain("proof_admin_api_ingress_routes");
    expect(platformLocals).not.toContain("proof_web_ingress_routes");
    expect(platformRuntimeValues).toContain('"STRIPE_PUBLISHABLE_KEY"');
    expect(platformRuntimeValues).toContain('"CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE"');
    expect(platformRuntimeValues).toContain('"CHASE_SETS_INTERNAL_API_ORIGIN"');
    expect(platformRuntimeValues).toContain('"CHASE_SETS_MARKETPLACE_ORIGIN"');
    expect(platformLocals).toContain("context_names = local.active_runtime_context_names");
    expect(platformMain).not.toContain('check "production_marketplace_proof"');
    expect(platformMain).toContain('check "production_marketplace_promotion"');
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires production public runtime profile and complete Amazon SES transactional email configuration."',
    );
    expect(platformMain).toContain('check "production_runtime_profile_public_gate"');
    expect(platformMain).toContain(
      '(var.production_runtime_profile == "public") == var.production_marketplace_public_enabled',
    );
    expect(platformMain).toContain('check "production_marketplace_launch_approval"');
    expect(platformMain).not.toContain("var.production_marketplace_launch_evidence_reference");
    expect(platformMain).toContain("var.production_marketplace_promotion_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires an approved marketplace promotion record before deploying the public marketplace."',
    );
    expect(platformMain).toContain('check "production_marketplace_evidence_reference_quality"');
    expect(platformMain).toContain("var.production_transactional_email_reference");
    expect(platformMain).toContain("var.production_checkout_launch_evidence_reference");
    expect(platformMain).toContain("local.placeholder_evidence_references");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion evidence references must point to real external evidence records, not placeholders."',
    );
    expect(platformMain).toContain('check "production_marketplace_checkout_fee_approval"');
    expect(platformMain).toContain("var.production_marketplace_checkout_fee_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Marketplace Checkout Fee evidence before live checkout."',
    );
    expect(platformMain).toContain('check "production_checkout_launch_evidence_readiness"');
    expect(platformMain).toContain("var.production_checkout_launch_evidence_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved checkout launch evidence before public checkout."',
    );
    expect(platformMain).toContain('check "production_stripe_money_operations_readiness"');
    expect(platformMain).toContain("var.production_stripe_money_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Stripe money operations evidence before live payments and payouts."',
    );
    expect(platformMain).toContain('check "production_support_operations_readiness"');
    expect(platformMain).toContain("var.production_support_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Support readiness before live order support."',
    );
    expect(platformMain).toContain('check "production_fulfillment_postage_readiness"');
    expect(platformMain).toContain("var.production_fulfillment_postage_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Fulfillment postage evidence before live shipment labels."',
    );
    expect(platformRuntimeValues).toContain('"EASYPOST_WEBHOOK_SECRET"');
    expect(platformMain).toContain('check "production_transactional_email_readiness"');
    expect(platformMain).toContain("var.production_transactional_email_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved transactional email evidence before live marketplace notifications."',
    );
    expect(platformMain).toContain('check "production_launch_supply_measurements_readiness"');
    expect(platformMain).toContain("var.production_launch_supply_measurements_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved launch supply measurement evidence before public checkout."',
    );
    expect(platformMain).toContain('check "production_tax_readiness"');
    expect(platformMain).toContain("var.production_tax_readiness_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Tax readiness evidence before live order creation."',
    );
    expect(renderPlatformHelmValuesScript).toContain("platformApiIngressPrefixes");
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_public_enabled: ${{ vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_runtime_profile: ${{ vars.PRODUCTION_RUNTIME_PROFILE || (vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true' && 'public' || 'landing') }}",
    );
    expect(platformProductionWorkflow).toContain("pull-requests: read");
    expect(platformProductionWorkflow).toContain(
      "concurrency:\n  # Platform deploy builds, pushes, verifies, and release-tags DOCR images.\n  # Share this lane with registry cleanup so DigitalOcean GC cannot overlap\n  # registry-pushing deploy paths.\n  group: platform-registry-mutation\n  cancel-in-progress: false",
    );
    expect(platformProductionWorkflow).toContain("emergency_release:");
    expect(platformProductionWorkflow).toContain(
      "description: Bypass an active production release lock for an audited fix-forward or revert.",
    );
    expect(platformProductionWorkflow).toContain("emergency_reference:");
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_RELEASE_LOCKED: ${{ vars.PRODUCTION_RELEASE_LOCKED || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_RELEASE_LOCK_REASON: ${{ vars.PRODUCTION_RELEASE_LOCK_REASON || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_RELEASE_LOCK_REFERENCE: ${{ vars.PRODUCTION_RELEASE_LOCK_REFERENCE || '' }}",
    );
    const deployStagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    expect(deployStagingJob).toContain("applied: ${{ steps.staging_applied.outputs.applied || 'false' }}");
    expect(deployStagingJob).toContain("- name: Mark staging applied");
    expect(deployStagingJob).toContain('echo "applied=true" >> "$GITHUB_OUTPUT"');
    expect(deployStagingJob).not.toContain("Confirm automatic deploy is latest main");
    expect(platformProductionWorkflow).toContain(
      "if: always() && needs.resolve-release.outputs.deployment_required == 'true' && (needs.deploy-staging.outputs.applied != 'true' || needs.deploy-production.outputs.superseded == 'true')",
    );
    expect(platformProductionWorkflow).toContain(
      "STAGING_APPLIED: ${{ needs.deploy-staging.outputs.applied || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain('attempt_reason="staging-not-applied"');
    expect(platformProductionWorkflow).toContain("started_at: ${{ steps.staging_started.outputs.started_at }}");
    expect(platformProductionWorkflow).toContain("completed_at: ${{ steps.staging_completed.outputs.completed_at }}");
    expect(platformProductionWorkflow).toContain("- name: Record staging start");
    expect(platformProductionWorkflow).toContain("- name: Record staging completion");
    expect(platformProductionWorkflow).toContain("- name: Record production start");
    expect(platformProductionWorkflow).toContain("superseded: ${{ steps.latest_main.outputs.superseded || 'false' }}");
    expect(platformProductionWorkflow).toContain("superseded_by_commit: ${{ steps.latest_main.outputs.latest_main }}");
    expect(platformProductionWorkflow).toContain('echo "should_deploy=false"');
    expect(platformProductionWorkflow).toContain('echo "superseded=true"');
    expect(platformProductionWorkflow).toContain('echo "latest_main=${latest_main}"');
    expect(platformProductionWorkflow).toContain('} >> "$GITHUB_OUTPUT"');
    expect(platformProductionWorkflow).toContain("- name: Record superseded production deployment");
    expect(platformProductionWorkflow).toContain("if: env.SHOULD_DEPLOY == 'false'");
    expect(platformProductionWorkflow).toContain("Production deployment superseded");
    expect(platformProductionWorkflow).toContain("Superseding commit: ${latest_main}");
    const markProductionReleaseStep = workflowStep(platformProductionWorkflow, "Mark production release");
    expect(markProductionReleaseStep).toContain("id: production_marker");
    expect(markProductionReleaseStep).toContain('echo "marker_mismatch=true"');
    expect(markProductionReleaseStep).toContain("production-marker-non-fast-forward");
    expect(markProductionReleaseStep).toContain("production-marker-push-failed");
    expect(markProductionReleaseStep).toContain("Production marker mismatch");
    expect(markProductionReleaseStep).toContain("Deployed commit: ${release_commit}");
    expect(markProductionReleaseStep).toContain("Current production marker: ${production_marker_commit");
    expect(platformProductionWorkflow).toContain("- name: Evaluate production release lock");
    expect(workflowStep(platformProductionWorkflow, "Evaluate production release lock")).toContain(
      "GITHUB_TOKEN: ${{ github.token }}",
    );
    expect(workflowStep(platformProductionWorkflow, "Evaluate production release lock")).toContain(
      "GITHUB_REPOSITORY: ${{ github.repository }}",
    );
    expect(platformProductionWorkflow).toContain("RELEASE_COMMIT: ${{ needs.resolve-release.outputs.release_commit }}");
    expect(platformProductionWorkflow).toContain(
      "EMERGENCY_RELEASE_BYPASS: ${{ github.event_name == 'workflow_dispatch' && inputs.emergency_release == true && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "EMERGENCY_RELEASE_REFERENCE: ${{ github.event_name == 'workflow_dispatch' && inputs.emergency_reference || '' }}",
    );
    expect(platformProductionWorkflow).toContain("run: node ./scripts/release-lock.mjs");
    expect(workflowStep(platformProductionWorkflow, "Write release health summary")).toContain(
      "EMERGENCY_RELEASE_REFERENCE: ${{ steps.release_lock.outputs.emergency_reference }}",
    );
    expect(workflowStep(platformProductionWorkflow, "Write release health summary")).toContain(
      "RECOVERY_REFERENCE: ${{ steps.production_rollback.outputs.rollback_reference || steps.release_lock.outputs.emergency_reference }}",
    );
    expect(platformProductionWorkflow.indexOf("- name: Evaluate production release lock")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Validate production configuration"),
    );
    expect(platformProductionWorkflow).toContain("- name: Resolve release health metadata");
    expect(platformProductionWorkflow).toContain("SOURCE_WORKFLOW_CREATED_AT");
    expect(platformProductionWorkflow).toContain("node ./scripts/release-health-github-metadata.mjs");
    expect(platformProductionWorkflow).toContain('--release-commit "$release_commit"');
    expect(platformProductionWorkflow).toContain('echo "queue_merge_group_started_at="');
    expect(platformProductionWorkflow).toContain('echo "queue_batch_size=1"');
    expect(platformProductionWorkflow).toContain('echo "merge_sha=${release_commit}"');
    expect(platformProductionWorkflow).toContain('git rev-list --count "origin/production..${release_commit}"');
    expect(platformProductionWorkflow).toContain('echo "drift_commits=${drift_commits}"');
    expect(platformProductionWorkflow).toContain('echo "drift_seconds=${drift_seconds}"');
    expect(platformProductionWorkflow).toContain("- name: Write release health summary");
    expect(platformProductionWorkflow).toContain(
      "RELEASE_HEALTH_OUT: artifacts/release-health/production-release.json",
    );
    expect(platformProductionWorkflow).toContain(
      "RELEASE_MODE: ${{ github.event_name == 'workflow_dispatch' && inputs.emergency_release == true && 'emergency' || 'normal' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PR_OPENED_AT: ${{ steps.release_health_metadata.outputs.pr_opened_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PR_READY_FOR_REVIEW_AT: ${{ steps.release_health_metadata.outputs.pr_ready_for_review_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PR_APPROVED_AT: ${{ steps.release_health_metadata.outputs.pr_approved_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "QUEUE_BATCH_SIZE: ${{ steps.release_health_metadata.outputs.queue_batch_size || '1' }}",
    );
    expect(platformProductionWorkflow).not.toContain('QUEUE_BATCH_SIZE: "1"');
    expect(platformProductionWorkflow).toContain(
      "QUEUE_QUEUED_AT: ${{ steps.release_health_metadata.outputs.queue_queued_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "QUEUE_MERGE_GROUP_STARTED_AT: ${{ steps.release_health_metadata.outputs.queue_merge_group_started_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "QUEUE_DEQUEUED_AT: ${{ steps.release_health_metadata.outputs.queue_dequeued_at }}",
    );
    expect(platformProductionWorkflow).toContain("MERGE_SHA: ${{ steps.release_health_metadata.outputs.merge_sha }}");
    expect(platformProductionWorkflow).toContain(
      "RELEASE_COMMIT_COMMITTED_AT: ${{ steps.release_health_metadata.outputs.committed_at }}",
    );
    expect(platformProductionWorkflow).toContain("STAGING_RESULT: ${{ needs.deploy-staging.result }}");
    expect(platformProductionWorkflow).toContain("STAGING_STARTED_AT: ${{ needs.deploy-staging.outputs.started_at }}");
    expect(platformProductionWorkflow).toContain(
      "STAGING_COMPLETED_AT: ${{ needs.deploy-staging.outputs.completed_at }}",
    );
    expect(platformProductionWorkflow).toContain("record-staging-release-health:");
    expect(platformProductionWorkflow).toContain("name: Record Staging Release Health");
    expect(platformProductionWorkflow).toContain(
      "if: always() && needs.resolve-release.outputs.deployment_required == 'true' && (needs.deploy-staging.outputs.applied != 'true' || needs.deploy-production.outputs.superseded == 'true')",
    );
    expect(platformProductionWorkflow).toContain("- deploy-production");
    expect(platformProductionWorkflow).toContain("RELEASE_HEALTH_OUT: artifacts/release-health/staging-release.json");
    expect(platformProductionWorkflow).toContain("- name: Resolve staging CI retry metadata");
    expect(platformProductionWorkflow).toContain("STAGING_JOB_RESULT: ${{ needs.deploy-staging.result }}");
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_SUPERSEDED: ${{ needs.deploy-production.outputs.superseded }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_SUPERSEDED_BY_COMMIT: ${{ needs.deploy-production.outputs.superseded_by_commit }}",
    );
    expect(platformProductionWorkflow).toContain('attempt_phase="staging"');
    expect(platformProductionWorkflow).toContain('if [ "${PRODUCTION_SUPERSEDED:-}" = "true" ]; then');
    expect(platformProductionWorkflow).toContain('attempt_phase="production"');
    expect(platformProductionWorkflow).toContain('attempt_reason="production-superseded-by-newer-main"');
    expect(platformProductionWorkflow).toContain('superseded_by_commit="${PRODUCTION_SUPERSEDED_BY_COMMIT:-}"');
    expect(platformProductionWorkflow).toContain('export RELEASE_ATTEMPT_PHASE="$attempt_phase"');
    expect(platformProductionWorkflow).toContain('export RELEASE_ATTEMPT_SUPERSEDED_BY_COMMIT="$superseded_by_commit"');
    expect(platformProductionWorkflow).toContain("name: staging-release-health");
    const notifyProductionDeployIncidentJob = workflowJob(
      platformProductionWorkflow,
      "notify-production-deploy-incident",
    );
    expect(notifyProductionDeployIncidentJob).toContain("notify-production-deploy-incident:");
    expect(notifyProductionDeployIncidentJob).toContain("name: Notify Production Deploy Incident");
    expect(notifyProductionDeployIncidentJob).toContain("issues: write");
    expect(notifyProductionDeployIncidentJob).toContain("name: Classify deploy outcome");
    expect(notifyProductionDeployIncidentJob).toContain("id: classify_deploy_outcome");
    expect(notifyProductionDeployIncidentJob).toContain("node ./scripts/platform-deploy-incident.mjs");
    expect(notifyProductionDeployIncidentJob).toContain(
      "STAGING_APPLIED: ${{ needs.deploy-staging.outputs.applied || '' }}",
    );
    expect(notifyProductionDeployIncidentJob).toContain("needs.deploy-staging.outputs.applied != 'true'");
    expect(notifyProductionDeployIncidentJob).toContain("gh issue create");
    expect(notifyProductionDeployIncidentJob).toContain('incident_milestone_title="Incidents"');
    expect(notifyProductionDeployIncidentJob).toContain(
      "Open incident milestone '${incident_milestone_title}' was not found",
    );
    expect(notifyProductionDeployIncidentJob).toContain(
      'issue_create_args+=(--milestone "${incident_milestone_title}")',
    );
    expect(notifyProductionDeployIncidentJob).not.toContain('--milestone "Incidents"');
    expect(notifyProductionDeployIncidentJob).toContain("Incident: Platform Deploy failed for");
    expect(notifyProductionDeployIncidentJob).not.toContain("Kind: production-superseded");
    expect(notifyProductionDeployIncidentJob).toContain("needs.deploy-production.outputs.superseded == 'true'");
    expect(notifyProductionDeployIncidentJob).toContain('gh issue close "${issue_number}"');
    expect(notifyProductionDeployIncidentJob).toContain("--command classify-issue");
    expect(notifyProductionDeployIncidentJob).toContain("--command build-comment");
    expect(notifyProductionDeployIncidentJob).toContain(
      'contains(fromJSON(\'["failure", "cancelled"]\'), needs.deploy-production.result)',
    );
    expect(platformProductionWorkflow).toContain(
      'contains(fromJSON(\'["failure", "cancelled"]\'), needs.deploy-production.result)',
    );
    const closeResolvedDeployIncidentsJob = workflowJob(platformProductionWorkflow, "close-resolved-deploy-incidents");
    expect(closeResolvedDeployIncidentsJob).toContain("name: Close Resolved Production Deploy Incidents");
    expect(closeResolvedDeployIncidentsJob).toContain("needs.deploy-production.result == 'success'");
    expect(closeResolvedDeployIncidentsJob).toContain("needs.deploy-production.outputs.superseded != 'true'");
    expect(closeResolvedDeployIncidentsJob).toContain("issues: write");
    expect(closeResolvedDeployIncidentsJob).toContain("Close resolved deploy incidents");
    expect(closeResolvedDeployIncidentsJob).toContain('--search "\\"Incident: Platform Deploy\\" in:title"');
    expect(closeResolvedDeployIncidentsJob).toContain(
      'startswith("Incident: Platform Deploy superseded before production for ")',
    );
    expect(closeResolvedDeployIncidentsJob).toContain("Resolving workflow run: ${RUN_URL}");
    expect(closeResolvedDeployIncidentsJob).toContain("Resolving release commit: ${release_commit}");
    expect(closeResolvedDeployIncidentsJob).toContain('gh issue close "${issue_number}"');
    expect(platformProductionWorkflow).toContain("- name: Stage 1 production canary");
    expect(platformProductionWorkflow.indexOf("- name: Stage 1 production canary")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Mark production release"),
    );
    expect(platformProductionWorkflow).not.toContain("- name: Production proof-mode Buy Now freshness probe");
    expect(platformProductionWorkflow).not.toContain("- name: Production settlement provider-health telemetry probe");
    // The baseline-vs-canary promotion-evidence gate (canary-evidence.mjs /
    // canary-analysis.json) was removed in #2507: it modeled a canary deploy
    // that does not exist (rolling deploy), was half-uninstrumented, and never
    // blocked. The post-deploy smoke probes below are kept.
    expect(platformProductionWorkflow).not.toContain("stage1-production-canary-telemetry.json");
    expect(platformProductionWorkflow).not.toContain("- name: Collect production canary observability evidence");
    expect(platformProductionWorkflow).not.toContain("canary-evidence.mjs");
    expect(platformProductionWorkflow).not.toContain("CANARY_PROMETHEUS");
    expect(platformProductionWorkflow).toContain("- name: Resolve CI retry metadata");
    expect(platformProductionWorkflow).toContain("node ./scripts/release-health-ci-metadata.mjs");
    expect(platformProductionWorkflow).toContain("CI_RETRY_COUNT: ${{ steps.ci_metadata.outputs.ci_retry_count }}");
    expect(platformProductionWorkflow).toContain(
      "CANARY_RESULT: ${{ env.SHOULD_DEPLOY == 'false' && 'skipped' || steps.stage1_canary.outcome || 'skipped' }}",
    );
    expect(platformProductionWorkflow).not.toContain("CANARY_EVIDENCE_RESULT");
    expect(platformProductionWorkflow).toContain("CANARY_STARTED_AT: ${{ steps.stage1_canary.outputs.started_at }}");
    expect(platformProductionWorkflow).toContain(
      "CANARY_COMPLETED_AT: ${{ steps.stage1_canary.outputs.completed_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "CANARY_SKIPPED_REASON: ${{ env.SHOULD_DEPLOY == 'false' && 'production-superseded-by-newer-main' || steps.stage1_canary.outcome == 'skipped' && 'stage-1-canary-not-run' || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "CANARY_PROMOTION_DECISION: ${{ env.SHOULD_DEPLOY == 'false' && 'skipped' || steps.stage1_canary.outcome == 'success' && 'promote' || steps.stage1_canary.outcome == 'failure' && 'abort' || 'skipped' }}",
    );
    expect(platformProductionWorkflow).not.toContain("Install Playwright Chromium for production proof probe");
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_RESULT: ${{ env.SHOULD_DEPLOY == 'false' && 'skipped' || job.status }}",
    );
    expect(platformProductionWorkflow).toContain(
      "RELEASE_ATTEMPT_RESULT: ${{ env.SHOULD_DEPLOY == 'false' && 'skipped' || job.status }}",
    );
    expect(platformProductionWorkflow).toContain(
      "RELEASE_ATTEMPT_REASON: ${{ env.SHOULD_DEPLOY == 'false' && 'production-superseded-by-newer-main' || steps.production_marker.outputs.marker_mismatch == 'true' && 'production-marker-mismatch' || 'production-release' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "RELEASE_ATTEMPT_SUPERSEDED_BY_COMMIT: ${{ env.SHOULD_DEPLOY == 'false' && steps.latest_main.outputs.latest_main || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_STARTED_AT: ${{ steps.production_started.outputs.started_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_COMPLETED_AT: ${{ steps.release_health_metadata.outputs.completed_at }}",
    );
    expect(platformProductionWorkflow).toContain(
      "MAIN_TO_PRODUCTION_DRIFT_COMMITS: ${{ steps.release_health_metadata.outputs.drift_commits }}",
    );
    expect(platformProductionWorkflow).toContain("run: node ./scripts/release-health.mjs");
    expect(platformProductionWorkflow).toContain("- name: Upload release health summary");
    expect(platformProductionWorkflow).toContain("name: production-release-health");
    expect(platformProductionWorkflow).not.toContain("artifacts/release-health/canary-analysis.json");
    expect(platformProductionWorkflow).not.toContain(
      "artifacts/release-health/production-settlement-provider-health-probe.json",
    );
    expect(platformProductionWorkflow).not.toContain(
      "artifacts/release-health/production-proof-buy-now-freshness-probe.json",
    );
    expect(platformProductionWorkflow).toContain("retention-days: 30");
    expect(platformProductionWorkflow).not.toContain("TF_VAR_production_marketplace_launch_evidence_reference");
    expect(platformProductionWorkflow).not.toContain("TF_VAR_production_marketplace_proof_enabled");
    expect(platformProductionWorkflow).not.toContain("TF_VAR_production_marketplace_proof_reference");
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_promotion_approved: ${{ vars.PRODUCTION_MARKETPLACE_PROMOTION_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_promotion_reference: ${{ vars.PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_checkout_fee_approved: ${{ vars.PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_checkout_fee_reference: ${{ vars.PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_checkout_launch_evidence_approved: ${{ vars.PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_checkout_launch_evidence_reference: ${{ vars.PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE: ${{ vars.CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE == 'true' && 'true' || 'false' }}",
    );
    expect(occurrenceCount(platformProductionWorkflow, "CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE:")).toBe(2);
    expect(platformStagingResetWorkflow).not.toContain("CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE");
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_stripe_money_operations_approved: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_stripe_money_operations_reference: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "STRIPE_CONNECT_WEBHOOK_SECRET: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && secrets.STRIPE_CONNECT_WEBHOOK_SECRET || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "STRIPE_CONNECT_ACCOUNTS_API: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && (vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2') || 'v2' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_support_operations_approved: ${{ vars.PRODUCTION_SUPPORT_OPERATIONS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_support_operations_reference: ${{ vars.PRODUCTION_SUPPORT_OPERATIONS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_fulfillment_postage_approved: ${{ vars.PRODUCTION_FULFILLMENT_POSTAGE_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_fulfillment_postage_reference: ${{ vars.PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "EASYPOST_WEBHOOK_SECRET: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && secrets.EASYPOST_WEBHOOK_SECRET || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "GOOGLE_SOCIAL_LOGIN_CLIENT_ID: ${{ secrets.GOOGLE_SOCIAL_LOGIN_CLIENT_ID || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET: ${{ secrets.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS: ${{ vars.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_transactional_email_approved: ${{ vars.PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_transactional_email_reference: ${{ vars.PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_launch_supply_measurements_approved: ${{ vars.PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_launch_supply_measurements_reference: ${{ vars.PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_tax_readiness_approved: ${{ vars.PRODUCTION_TAX_READINESS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_tax_readiness_reference: ${{ vars.PRODUCTION_TAX_READINESS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "PRODUCTION_TAX_PROVIDER_BACKED_QUOTES_REQUIRED_RAW: ${{ vars.TAX_PROVIDER_BACKED_QUOTES_REQUIRED || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "Production proof/public platform deployment requires Stripe live-mode keys.",
    );
    expect(platformProductionWorkflow).toContain("Missing required production marketplace platform configuration");
    expect(platformProductionWorkflow).toContain(
      "Production proof/public platform deployment requires EASYPOST_MODE=production.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production proof/public platform deployment requires STRIPE_API_BASE_URL to be unset.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production proof/public platform deployment requires EASYPOST_API_BASE_URL to be unset.",
    );
    expect(platformProductionWorkflow).toContain("Missing required production Google Workspace SSO configuration");
    expect(platformProductionWorkflow).not.toContain(
      "Production marketplace proof mode requires an evidence-collection approval reference.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires an approved marketplace promotion record.",
    );
    expect(platformProductionWorkflow).not.toContain("Marketplace Launch Evidence packet reference");
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Marketplace Checkout Fee evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved checkout launch evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Stripe money operations evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Support readiness.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Fulfillment postage evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved transactional email evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved launch supply measurement evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Tax readiness evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires TAX_PROVIDER_BACKED_QUOTES_REQUIRED to be explicitly true or false.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires NOTIFICATION_EMAIL_PROVIDER=amazon-ses.",
    );
    expect(platformProductionWorkflow).toContain(
      'if [ "${TF_VAR_production_runtime_profile:-landing}" = "landing" ]; then',
    );
    expect(platformProductionWorkflow).toContain('export SMOKE_REQUIRE_NATIVE_MCP="false"');
    expect(platformProductionWorkflow).toContain('export SMOKE_REQUIRE_NATIVE_MCP="true"');
    expect(platformProductionWorkflow).toContain(
      'export SMOKE_REQUIRE_FULFILLMENT_POSTAGE="${TF_VAR_production_fulfillment_postage_approved:-false}"',
    );
    expect(platformProductionWorkflow).toContain('export SMOKE_ADMIN_TOPOLOGY="public-marketplace"');
    expect(platformProductionWorkflow).toContain('export SMOKE_ADMIN_TOPOLOGY="production-platform-disabled"');
    expect(platformProductionWorkflow).toContain('export SMOKE_REQUIRE_MARKETPLACE="true"');
  });

  it("guards scheduled registry cleanup against queued or active platform deploys", () => {
    const deployLaneStep = workflowStep(platformRegistryCleanupWorkflow, "Check deploy lane");
    const cleanupStep = workflowStep(platformRegistryCleanupWorkflow, "Cleanup registry tags");

    expect(platformRegistryCleanupWorkflow).toContain("actions: read");
    expect(platformRegistryCleanupWorkflow).toContain("group: platform-registry-mutation");
    expect(platformProductionWorkflow).toContain("group: platform-registry-mutation");
    expect(platformStagingResetWorkflow).toContain("group: platform-registry-mutation");
    expect(platformStagingResetWorkflow).toContain("group: platform-deploy-staging");
    expect(platformRegistryCleanupWorkflow).toContain("DOCR garbage collection makes the registry read-only");
    expect(platformProductionWorkflow).toContain("release-tags DOCR images");
    expect(platformStagingResetWorkflow).toContain("Queue DOKS redeploy after database recreation");
    expect(deployLaneStep).toContain('const workflows = ["platform-production.yml", "platform-staging-reset.yml"];');
    expect(deployLaneStep).toContain('const statuses = ["queued", "in_progress", "waiting", "requested", "pending"];');
    expect(deployLaneStep).toContain('reason: "deploy-lane-active"');
    expect(deployLaneStep).toContain('result: "deferred"');
    expect(cleanupStep).toContain("if: steps.deploy_lane.outputs.deferred != 'true'");
    expect(cleanupStep).toContain("--retain-recent-sha-tree-tags=25");
    expect(cleanupStep).not.toContain("--retention-days=7");
    expect(digitaloceanPlatformRunbook).toContain(
      "Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup share the `platform-registry-mutation` GitHub Actions concurrency group",
    );
  });

  it("captures sensitive Terraform errored state artifacts when platform apply fails", () => {
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
    expect(fullBatteryStep).toContain("contains(github.event.pull_request.labels.*.name, 'full-pr-battery')");
    expect(fullBatteryStep).toContain("contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(fullBatteryStep).toContain(
      "INTEGRATION_RISK_REQUIRED: ${{ steps.scope.outputs.integration_risk_required }}",
    );
    expect(fullBatteryStep).toContain('targeted_reason="integration-risk: $INTEGRATION_RISK_REASON"');

    for (const job of [buildJob, dockerJob, terraformPreviewJob, terraformStagingJob, terraformProductionJob]) {
      expect(job).toContain("needs['change-scope'].outputs.full_battery_required == 'true'");
    }

    for (const job of [dbProfileJob, e2eJob]) {
      expect(job).toContain("needs['change-scope'].outputs.full_battery_required == 'true'");
      expect(job).toContain("needs['change-scope'].outputs.integration_risk_required == 'true'");
    }

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

    expect(requiredJob).toContain(
      "full_battery_required=\"${{ needs['change-scope'].outputs.full_battery_required }}\"",
    );
    expect(requiredJob).toContain(
      "targeted_heavy_required=\"${{ needs['change-scope'].outputs.targeted_heavy_required }}\"",
    );
    expect(requiredJob).toContain('require_targeted_heavy_job "DB Profile Tests"');
    expect(requiredJob).toContain('require_targeted_heavy_job "E2E Tests"');
    expect(requiredJob).toContain('require_heavy_job "Build"');
    expect(requiredJob).toContain('require_heavy_job "Docker Image Build"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Preview Plan"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Staging Plan"');
    expect(requiredJob).toContain('require_heavy_job "Terraform Production Plan"');
    expect(requiredJob).toContain('require_job "Terraform Observability Plan"');
    expect(requiredJob).toContain('require_job "Workflow Lint"');
  });

  it("requires preview deploy and smoke for deploy-scoped same-repository PRs without blocking forks", () => {
    const previewJob = workflowJob(platformPrWorkflow, "preview-deploy-smoke");
    const requiredJob = workflowJob(platformPrWorkflow, "pr-required");

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
    // chart's preview env defaults already carry the runtime
    // preview posture when a repository variable is unset.
    expect(previewJob).toContain('add_optional_runtime_env "STRIPE_API_BASE_URL" "${STRIPE_API_BASE_URL:-}"');
    expect(previewJob).toContain('add_optional_runtime_env "EASYPOST_API_BASE_URL" "${EASYPOST_API_BASE_URL:-}"');
    expect(previewJob).toContain('add_optional_runtime_env "SES_AWS_REGION" "${TF_VAR_ses_aws_region:-}"');
    expect(previewJob).toContain('add_optional_runtime_env "SES_FROM_EMAIL" "${TF_VAR_ses_from_email:-}"');
    expect(previewJob).toContain(
      'add_optional_runtime_env "SES_CONFIGURATION_SET_NAME" "${TF_VAR_ses_configuration_set_name:-}"',
    );
    expect(previewJob).not.toContain('--runtime-env "STRIPE_API_BASE_URL=');
    expect(previewJob).not.toContain('--runtime-env "EASYPOST_API_BASE_URL=');
    expect(previewJob).not.toContain('--runtime-env "SES_');

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

  it("fails pre-merge production plans with unapproved destructive changes", () => {
    const productionPlanStep = workflowStep(platformPrWorkflow, "Terraform plan production platform");
    const deployProductionPlanStep = workflowSteps(platformProductionWorkflow, "Terraform plan").at(-1);

    expect(platformPrWorkflow).toContain(
      "DESTRUCTIVE_CHANGE_ALLOW_FILE: .github/deployment/production-destructive-change-approved.md",
    );
    expect(productionPlanStep).toContain('cd "$tmp"');
    expect(productionPlanStep).toContain(
      'node "$GITHUB_WORKSPACE/scripts/terraform-plan-inspection.mjs" assert-no-destructive-changes tfplan --allow-file="$GITHUB_WORKSPACE/${DESTRUCTIVE_CHANGE_ALLOW_FILE}"',
    );
    expect(deployProductionPlanStep).toContain(
      "node ../../../scripts/terraform-plan-inspection.mjs assert-no-destructive-changes tfplan",
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
    expect(dbCoverageStep).toContain("node ./scripts/run-workspaces.mjs test:db --concurrency=2");
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

    // The smoke mirrors Kubernetes run commands and health checks so a non-booting image
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

  it("boot-smokes the merge queue runtime image with deploy-time web component semantics", () => {
    const dockerImageJob = workflowJob(platformPrWorkflow, "docker-image");
    const buildStep = workflowStep(platformPrWorkflow, "Build runtime image");
    const smokeStep = workflowStep(platformPrWorkflow, "Boot smoke runtime image");
    const releaseSmokeStep = workflowStep(platformProductionWorkflow, "Boot smoke release image");

    expect(dockerImageJob).toContain(
      "if: needs['change-scope'].outputs.full_battery_required == 'true' && needs['change-scope'].outputs.docker_image == 'true'",
    );
    expect(buildStep).toContain("--load \\");
    expect(buildStep).toContain("--tag chase-sets-platform:pr-validation");

    expect(smokeStep).toContain("if: github.event_name == 'merge_group'");
    expect(smokeStep).toContain("PLATFORM_IMAGE: chase-sets-platform:pr-validation");
    expect(smokeStep).toContain("-e NODE_ENV=production");
    expect(smokeStep).toContain("-e PORT=8080");
    expect(smokeStep).toContain('pnpm --filter "$workspace" run start');
    expect(smokeStep).toContain('boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080');
    expect(smokeStep).toContain('boot_smoke public-web "@chase-sets/app-public-web" / 18081');

    for (const deployTimeSemantics of [
      'boot_smoke marketplace "@chase-sets/app-marketplace-web" /health/ready 18080',
      'boot_smoke public-web "@chase-sets/app-public-web" / 18081',
    ]) {
      expect(releaseSmokeStep).toContain(deployTimeSemantics);
      expect(smokeStep).toContain(deployTimeSemantics);
    }

    const buildIndex = platformPrWorkflow.indexOf("- name: Build runtime image");
    const smokeIndex = platformPrWorkflow.indexOf("- name: Boot smoke runtime image");
    expect(buildIndex).toBeLessThan(smokeIndex);
  });

  it("publishes the boot-smoked merge queue runtime image by tree tag only after validation", () => {
    const dockerImageJob = workflowJob(platformPrWorkflow, "docker-image");
    const buildStep = workflowStep(platformPrWorkflow, "Build runtime image");
    const smokeStep = workflowStep(platformPrWorkflow, "Boot smoke runtime image");
    const pushStep = workflowStep(platformPrWorkflow, "Push boot-smoked merge-group image");
    const skippedPushStep = workflowStep(platformPrWorkflow, "Report skipped merge-group image push");

    expect(dockerImageJob).toContain(
      "DIGITALOCEAN_REGISTRY_TOKEN: ${{ secrets.DIGITALOCEAN_REGISTRY_TOKEN || secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
    );
    expect(dockerImageJob).toContain("DIGITALOCEAN_CONTAINER_REGISTRY_FALLBACK: chase-sets");
    expect(dockerImageJob).toContain("PLATFORM_IMAGE_REPOSITORY: chase-sets-platform");
    expect(dockerImageJob).toContain("digitalocean/action-doctl@3cb3953159719656269e044e0e24ca16dd2a690f");
    expect(dockerImageJob).toContain("if: github.event_name == 'merge_group' && env.DIGITALOCEAN_REGISTRY_TOKEN != ''");
    expect(dockerImageJob).toContain("token: ${{ env.DIGITALOCEAN_REGISTRY_TOKEN }}");
    expect(buildStep).toContain("--load \\");
    expect(buildStep).not.toContain("--push");

    expect(pushStep).toContain("if: github.event_name == 'merge_group' && env.DIGITALOCEAN_REGISTRY_TOKEN != ''");
    expect(pushStep).toContain("PLATFORM_IMAGE: chase-sets-platform:pr-validation");
    expect(pushStep).toContain("tree_tag=\"tree-$(git rev-parse 'HEAD^{tree}')\"");
    expect(pushStep).toContain("doctl registry login --expiry-seconds 3600");
    expect(pushStep).toContain(
      'image="registry.digitalocean.com/${registry_name}/${PLATFORM_IMAGE_REPOSITORY}:${tree_tag}"',
    );
    expect(pushStep).toContain('docker tag "$PLATFORM_IMAGE" "$image"');
    expect(pushStep).toContain('docker push "$image"');
    expect(pushStep).not.toContain("TF_VAR_platform_image_tag");
    expect(skippedPushStep).toContain(
      "if: github.event_name == 'merge_group' && env.DIGITALOCEAN_REGISTRY_TOKEN == ''",
    );
    expect(skippedPushStep).toContain("DigitalOcean registry credentials are unavailable");
    expect(skippedPushStep).toContain("build and boot smoke still validated the image");

    const buildIndex = platformPrWorkflow.indexOf("- name: Build runtime image");
    const smokeIndex = platformPrWorkflow.indexOf("- name: Boot smoke runtime image");
    const pushIndex = platformPrWorkflow.indexOf("- name: Push boot-smoked merge-group image");
    const skippedPushIndex = platformPrWorkflow.indexOf("- name: Report skipped merge-group image push");
    expect(buildIndex).toBeLessThan(smokeIndex);
    expect(smokeIndex).toBeLessThan(pushIndex);
    expect(smokeIndex).toBeLessThan(skippedPushIndex);
  });

  it("deploys Kubernetes releases by the verified image digest", () => {
    const stagingImageStep = workflowStep(platformProductionWorkflow, "Resolve staged release image");
    const productionImageStep = workflowStep(platformProductionWorkflow, "Verify promoted release image");

    expect(platformProductionWorkflow).toContain("platform_image_digest: ${{ steps.image.outputs.digest }}");
    expect(stagingImageStep).toContain('digest="$(docker buildx imagetools inspect "$image" --format');
    expect(stagingImageStep).toContain('echo "PLATFORM_IMAGE_DIGEST=${digest}" >> "$GITHUB_ENV"');
    expect(platformProductionWorkflow).toContain(
      "PLATFORM_IMAGE_DIGEST: ${{ needs.deploy-staging.outputs.platform_image_digest }}",
    );

    expect(productionImageStep).toContain('expected_digest="${PLATFORM_IMAGE_DIGEST}"');
    expect(productionImageStep).toContain("Staging did not publish a verified release image digest");
    expect(productionImageStep).toContain('if [ "$digest" != "$expected_digest" ]; then');
    expect(productionImageStep).toContain("did not match staging verified digest");
    expect(productionImageStep).toContain('echo "PLATFORM_IMAGE_DIGEST=${digest}" >> "$GITHUB_ENV"');
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
    expect(dockerfile.indexOf("USER node")).toBeGreaterThan(dockerfile.indexOf("RUN pnpm run sync:workspace-metadata"));
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

  it("delegates staging DNS while DOKS live routing coexists with mail records", () => {
    expect(environmentDnsVariables).toContain('condition     = var.environment == "staging"');
    expect(environmentDnsLocals).toContain('environment_zone = "${var.environment}.${var.root_domain}"');
    expect(environmentDnsMain).toContain('resource "digitalocean_domain" "environment"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "delegation"');
    expect(environmentDnsMain).toContain('type   = "NS"');
    expect(environmentDnsMain).toContain('type     = "MX"');
    expect(environmentDnsLocals).toContain('value    = "smtp.google.com."');
    expect(environmentDnsMain).toContain('name   = "google._domainkey"');
    expect(environmentDnsMain).toContain('value  = "v=spf1 include:_spf.google.com ~all"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "ses_dkim"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "catalog_assets"');
    expect(environmentDnsLocals).toContain(
      'catalog_asset_cdn_endpoint = "chase-sets-${var.environment}-catalog-assets.${var.data_region}.cdn.digitaloceanspaces.com."',
    );
    expect(environmentDnsVariables).toContain('variable "doks_ingress_target"');
    expect(environmentDnsVariables).toContain("DOKS ingress load balancer IPv4 address");
    expect(environmentDnsLocals).toContain("local.doks_ingress_target_configured ? {");
    expect(environmentDnsLocals).toContain(
      'fqdn = name == "@" ? local.environment_zone : "${name}.${local.environment_zone}"',
    );
    expect(environmentDnsMain).toContain('check "doks_ingress_serving_target"');
    expect(environmentDnsMain).toContain('resource "digitalocean_record" "doks_ingress_serving"');
    expect(environmentDnsMain).toContain("for_each = local.doks_serving_records");
    expect(environmentDnsMain).toContain('type   = "A"');
    expect(environmentDnsOutputs).toContain('output "doks_ingress_serving_domains"');
    expect(platformProductionWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformStagingResetWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformProductionWorkflow).not.toContain("staging_app_serving");
    expect(platformStagingResetWorkflow).not.toContain("staging_app_serving");
  });

  it("keeps DOKS as the single rollout lane", () => {
    const deployStagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const envDnsApplyStep = workflowStep(deployStagingJob, "Terraform apply staging environment DNS");
    const smokeStep = workflowSteps(deployStagingJob, "Smoke check").at(-1);

    expect(deployStagingJob).toContain("DOKS_INGRESS_TARGET: ${{ vars.DOKS_INGRESS_TARGET || '' }}");
    expect(envDnsApplyStep).toContain("TF_VAR_doks_ingress_target: ${{ env.DOKS_INGRESS_TARGET }}");
    expect(deployStagingJob).not.toContain("APP_PLATFORM_LANE");
    expect(deployStagingJob).not.toContain("STAGING_APP_SERVING");
    expect(smokeStep).toContain("live staging hosts served by DOKS");
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
      expect(step).toContain("terraform state pull");
      expect(step).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
      expect(step).toContain('--state "$state_path"');
      expect(step).toContain('--github-env "$GITHUB_ENV"');
      expect(step).not.toContain("node <<'NODE'");
      expect(step).not.toContain("digitalocean_database_cluster");
    }
    expect(providerProofStep).toContain("--contexts payments,settlement,fulfillment");
  });

  it("defines platform Terraform deployment inputs once per job instead of per plan/apply step", () => {
    const stagingJob = workflowJob(platformProductionWorkflow, "deploy-staging");
    const productionJob = workflowJob(platformProductionWorkflow, "deploy-production");
    const resetJob = workflowJob(platformStagingResetWorkflow, "reset-staging");

    for (const job of [stagingJob, productionJob, resetJob]) {
      expect(job).toContain("TF_VAR_digitalocean_token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
      expect(job).toContain("TF_VAR_spaces_access_id: ${{ secrets.SPACES_ACCESS_ID }}");
      expect(job).toContain("TF_VAR_spaces_secret_key: ${{ secrets.SPACES_SECRET_KEY }}");
      expect(job).toContain("TF_VAR_notification_email_provider: ${{ vars.NOTIFICATION_EMAIL_PROVIDER || 'noop' }}");
      expect(job).toContain("TF_VAR_observability_otlp_headers: ${{ secrets.OBSERVABILITY_OTLP_HEADERS || '' }}");
    }

    for (const job of [stagingJob, productionJob]) {
      expect(job).toContain("PLATFORM_INTERNAL_AUTH_SECRET: ${{ secrets.PLATFORM_INTERNAL_AUTH_SECRET }}");
      expect(job).toContain("PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL }}");
      expect(job).toContain("PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD }}");
    }
    expect(resetJob).not.toContain("PLATFORM_INTERNAL_AUTH_SECRET");

    expect(stagingJob).toContain("STRIPE_API_BASE_URL: ${{ vars.STRIPE_API_BASE_URL || '' }}");
    expect(stagingJob).toContain("STRIPE_CONNECT_ACCOUNTS_API: ${{ vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2' }}");
    expect(stagingJob).toContain("EASYPOST_WEBHOOK_SECRET: ${{ secrets.EASYPOST_WEBHOOK_SECRET || '' }}");
    expect(productionJob).toContain(
      "STRIPE_API_BASE_URL: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && vars.STRIPE_API_BASE_URL || '' }}",
    );
    expect(productionJob).toContain(
      "STRIPE_CONNECT_ACCOUNTS_API: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && (vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2') || 'v2' }}",
    );
    expect(productionJob).toContain(
      "EASYPOST_WEBHOOK_SECRET: ${{ (vars.PRODUCTION_RUNTIME_PROFILE == 'proof' || vars.PRODUCTION_RUNTIME_PROFILE == 'public' || vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true') && secrets.EASYPOST_WEBHOOK_SECRET || '' }}",
    );
    expect(resetJob).toContain("Queue DOKS redeploy after database recreation");

    const platformPlanApplySteps = [
      ...workflowSteps(platformProductionWorkflow, "Terraform plan"),
      ...workflowSteps(platformProductionWorkflow, "Terraform apply"),
      ...workflowSteps(platformStagingResetWorkflow, "Terraform plan staging recreate"),
      ...workflowSteps(platformStagingResetWorkflow, "Terraform apply staging recreate"),
    ];

    for (const step of platformPlanApplySteps) {
      expect(step).not.toMatch(/\n\s+TF_VAR_[A-Za-z0-9_]+:/);
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
    expect(platformPreviewCleanupWorkflow).not.toContain("TF_VAR_platform_image_tag");
    expect(platformPreviewCleanupWorkflow).toContain("ref: ${{ matrix.checkout_ref }}");
    expect(platformPreviewCleanupWorkflow).toContain(
      "-backend-config=key=platform/previews/pr-${{ matrix.pr_number }}.tfstate",
    );
    expect(platformPreviewCleanupWorkflow).not.toContain("doctl apps");
    expect(platformPreviewCleanupWorkflow).not.toContain("digitalocean-app-deployment.mjs");
    expect(digitaloceanPlatformRunbook).toContain(
      "Inspect the uploaded cleanup logs before removing a legacy state key by hand.",
    );
    expect(digitaloceanPlatformRunbook).toContain("DOKS is the single compute deploy target");
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

  it("pins the managed data region and manages uptime checks", () => {
    expect(platformVariables).toContain('variable "data_region"');
    expect(platformVariables).toContain('default     = "nyc3"');
    expect(platformMain).toContain("region           = var.data_region");
    expect(platformMain).toContain('resource "digitalocean_uptime_check" "platform"');
    expect(platformMain).toContain('resource "digitalocean_uptime_alert" "platform_down"');
    expect(platformLocals).toContain("uptime_check_targets = merge(");
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
    expect(platformRepresentativeWorkflow).toContain("terraform state pull");
    expect(platformRepresentativeWorkflow).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
    expect(platformRepresentativeWorkflow).toContain("--environment staging");
    expect(platformRepresentativeWorkflow).toContain('--github-env "$GITHUB_ENV"');
    expect(platformRepresentativeWorkflow).toContain("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND: s3");
    expect(platformRepresentativeWorkflow).toContain(
      "pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production",
    );
    expect(platformProductionWorkflow).not.toContain("representative-commerce-state:production");
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
    expect(restoreStep).toContain("DIGITALOCEAN_DATABASE_RESTORE_DRILL_OUT");
    expect(restoreStep).toContain("node ./scripts/digitalocean-database-restore-drill.mjs");
    expect(platformDatabaseRestoreDrillWorkflow).toContain("token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    expect(uploadStep).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(uploadStep).toContain("platform-database-restore-drill-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(uploadStep).toContain("retention-days: 30");
    expect(platformDatabaseRestoreDrillWorkflow).not.toContain("PRODUCTION_DATABASE_CLUSTER_ID");
    expect(platformDatabaseRestoreDrillWorkflow).not.toContain("DEPLOYMENT_ENVIRONMENT: production");
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
    expect(rollbackStep).toContain('--out "$rollback_record"');
    expect(rollbackStep).toContain('--github-output "$GITHUB_OUTPUT"');
    expect(rollbackStep).toContain('args+=(--revision "$ROLLBACK_REVISION")');
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

  it("gates production promotion on staging marketplace critical flows", () => {
    const stagingPlaywrightVersionStep = workflowStep(
      platformProductionWorkflow,
      "Resolve Playwright Chromium version",
    );
    const stagingPlaywrightCacheStep = workflowStep(
      platformProductionWorkflow,
      "Cache Playwright Chromium for staging critical flows",
    );
    const stagingPlaywrightInstallStep = workflowStep(
      platformProductionWorkflow,
      "Install Playwright Chromium for staging critical flows",
    );
    const stagingCriticalFlowStep = workflowStep(platformProductionWorkflow, "Staging marketplace critical flows");
    const stagingBuyNowProbesStep = workflowStep(platformProductionWorkflow, "Staging Buy Now freshness probes");
    const stagingBuyNowEvidenceStep = workflowStep(platformProductionWorkflow, "Upload staging Buy Now probe evidence");
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
    expect(stagingPlaywrightInstallStep).toContain("if: env.SHOULD_DEPLOY != 'false'");
    expect(stagingPlaywrightInstallStep).not.toContain("cache-hit != 'true'");
    expect(stagingPlaywrightInstallStep).toContain("PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright");
    expect(stagingPlaywrightInstallStep).toContain("pnpm exec playwright install --with-deps chromium");
    expect(platformProductionWorkflow.indexOf("- name: Resolve Playwright Chromium version")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Cache Playwright Chromium for staging critical flows"),
    );
    expect(
      platformProductionWorkflow.indexOf("- name: Cache Playwright Chromium for staging critical flows"),
    ).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Install Playwright Chromium for staging critical flows"),
    );
    expect(
      platformProductionWorkflow.indexOf("- name: Install Playwright Chromium for staging critical flows"),
    ).toBeLessThan(platformProductionWorkflow.indexOf("- name: Staging marketplace critical flows"));
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_SKIP_WEB_SERVER");
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright");
    expect(stagingCriticalFlowStep).toContain('admin_domain="$(terraform output -raw admin_domain)"');
    expect(stagingCriticalFlowStep).toContain('ADMIN_WEB_URL="https://${admin_domain}"');
    expect(stagingCriticalFlowStep).toContain('MARKETPLACE_WEB_URL="https://${marketplace_domain}"');
    expect(stagingCriticalFlowStep).toContain("pnpm run test:e2e:deployed");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_EMAIL");
    expect(stagingCriticalFlowStep).toContain("MARKETPLACE_E2E_PASSWORD");
    expect(stagingCriticalFlowStep).toContain("CATALOG_ADMIN_E2E_EMAIL");
    expect(stagingCriticalFlowStep).toContain("CATALOG_ADMIN_E2E_PASSWORD");
    expect(stagingCriticalFlowStep).toContain("vars.MARKETPLACE_E2E_EMAIL || ''");
    expect(stagingCriticalFlowStep).toContain("secrets.MARKETPLACE_E2E_PASSWORD || ''");
    expect(stagingCriticalFlowStep).toContain("vars.CATALOG_ADMIN_E2E_EMAIL || ''");
    expect(stagingCriticalFlowStep).toContain("secrets.CATALOG_ADMIN_E2E_PASSWORD || ''");
    expect(stagingCriticalFlowStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingCriticalFlowStep).toContain("AWS_SECRET_ACCESS_KEY");
    expect(platformProductionWorkflow).toContain("staging-playwright-critical-flow-artifacts");
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
    expect(stagingBuyNowProbesStep).toContain("guest_failure_reason=");
    expect(stagingBuyNowProbesStep).toContain("account_failure_reason=");
    expect(stagingBuyNowProbesStep).toContain(
      'echo "| Flow | Final state | Promotion decision | Failure reason | Ready latency (ms) | Correlation id |"',
    );
    expect(stagingBuyNowProbesStep).toContain("MARKETPLACE_E2E_EMAIL: ${{ vars.MARKETPLACE_E2E_EMAIL || '' }}");
    expect(stagingBuyNowProbesStep).toContain(
      "MARKETPLACE_E2E_PASSWORD: ${{ secrets.MARKETPLACE_E2E_PASSWORD || '' }}",
    );
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
      "PLATFORM_ADMIN_EMAIL: ${{ secrets.PLATFORM_ADMIN_EMAIL || env.PLATFORM_ADMIN_EMAIL || '' }}",
    );
    expect(stagingMoneySmokeStep).toContain(
      "PLATFORM_ADMIN_PASSWORD: ${{ secrets.PLATFORM_ADMIN_PASSWORD || env.PLATFORM_ADMIN_PASSWORD || '' }}",
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

    expect(platformProductionWorkflow.indexOf("- name: Staging marketplace critical flows")).toBeLessThan(
      markStagingDeployedIndex,
    );
    expect(platformProductionWorkflow.indexOf("- name: Staging Buy Now freshness probes")).toBeLessThan(
      markStagingDeployedIndex,
    );
    expect(platformProductionWorkflow.indexOf("- name: Staging Stripe money smoke")).toBeLessThan(
      markStagingDeployedIndex,
    );
  });
});
