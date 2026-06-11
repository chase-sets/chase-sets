import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_WEB_API_DEPENDENCIES } from "./admin-shell-smoke-matrix.mjs";

const platformMain = readFileSync(resolve("infrastructure/digitalocean/platform/main.tf"), "utf8");
const platformLocals = readFileSync(resolve("infrastructure/digitalocean/platform/locals.tf"), "utf8");
const platformOutputs = readFileSync(resolve("infrastructure/digitalocean/platform/outputs.tf"), "utf8");
const platformVariables = readFileSync(resolve("infrastructure/digitalocean/platform/variables.tf"), "utf8");
const catalogAssetsMain = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/main.tf"), "utf8");
const catalogAssetsLocals = readFileSync(resolve("infrastructure/digitalocean/catalog-assets/locals.tf"), "utf8");
const environmentDnsMain = readFileSync(resolve("infrastructure/digitalocean/environment-dns/main.tf"), "utf8");
const environmentDnsLocals = readFileSync(resolve("infrastructure/digitalocean/environment-dns/locals.tf"), "utf8");
const environmentDnsVariables = readFileSync(
  resolve("infrastructure/digitalocean/environment-dns/variables.tf"),
  "utf8",
);
const platformProductionWorkflow = readFileSync(resolve(".github/workflows/platform-production.yml"), "utf8");
const platformPrWorkflow = readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8");
const platformStagingResetWorkflow = readFileSync(resolve(".github/workflows/platform-staging-reset.yml"), "utf8");
const platformRepresentativeWorkflow = readFileSync(
  resolve(".github/workflows/platform-staging-representative-commerce-state.yml"),
  "utf8",
);
const adminWebViteConfig = readFileSync(resolve("deployables/admin-web/vite.config.ts"), "utf8");

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function expectTerraformAssignment(source, localName, expression) {
  expect(source).toMatch(new RegExp(`${localName}\\s+=\\s+${expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}

function workflowStep(source, stepName) {
  const start = source.indexOf(`- name: ${stepName}`);
  expect(start).not.toBe(-1);

  const next = source.indexOf("\n      - name:", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function terraformServiceBlock(source, serviceName) {
  const start = source.indexOf(`name               = "${serviceName}"`);
  expect(start).not.toBe(-1);

  const nextService = source.indexOf("\n    service", start + 1);
  const nextDynamicService = source.indexOf('\n    dynamic "service"', start + 1);
  const candidates = [nextService, nextDynamicService].filter((index) => index !== -1);
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
  const match = new RegExp(`${localName} = \\[([\\s\\S]*?)\\n  \\]`).exec(source);
  expect(match).not.toBeNull();
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
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
  return readdirSync(resolve("bounded-contexts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((contextName) => {
      const manifest = JSON.parse(readFileSync(resolve("bounded-contexts", contextName, "context.json"), "utf8"));
      return manifest.apiDeployables?.includes("platform-api");
    })
    .sort();
}

describe("DigitalOcean platform configuration", () => {
  it("keeps staging landing under the environment namespace and redirects the legacy dash host", () => {
    expect(platformLocals).toContain('local.is_staging ? "www.${var.environment}.${var.root_domain}"');
    expect(platformLocals).not.toContain('local.is_staging ? "${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain('"landing-${var.environment}.${var.root_domain}"     = local.landing_domain');
  });

  it("wires Catalog asset storage into production and non-production Catalog promotion components", () => {
    for (const key of [
      "CATALOG_ASSET_STORAGE_KIND",
      "CATALOG_ASSET_S3_BUCKET",
      "CATALOG_ASSET_S3_REGION",
      "CATALOG_ASSET_S3_ENDPOINT",
      "CATALOG_ASSET_PUBLIC_BASE_URL",
      "CATALOG_ASSET_S3_ACCESS_KEY_ID",
      "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    ]) {
      expect(occurrenceCount(platformMain, `key   = "${key}"`)).toBe(6);
    }

    expect(platformMain).toContain('name               = "platform-api"');
    expect(platformMain).toContain('name               = "platform-worker"');
    expect(platformMain).toContain('name               = "platform-bootstrap"');
    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(platformMain).toContain('name               = "admin-support-worker"');
    expect(platformMain).toContain('name               = "admin-support-bootstrap"');
    expect(platformMain).toContain("value = var.spaces_access_id");
    expect(platformMain).toContain("value = var.spaces_secret_key");
    expect(platformLocals).toContain("catalog_asset_s3_endpoint");
    expect(platformLocals).toContain("chase-sets-preview-catalog-assets");
    expect(platformLocals).toContain("https://assets.preview.${var.root_domain}");
    expect(platformLocals).toContain("catalog_asset_public_base_url");
    expect(platformOutputs).toContain('output "catalog_asset_public_base_url"');
    expect(platformVariables).not.toContain('variable "catalog_asset_s3_bucket"');
    expect(platformVariables).not.toContain('variable "catalog_asset_public_base_url"');

    const platformBootstrapJob = terraformJobBlock(platformMain, "platform-bootstrap");
    expect(platformBootstrapJob).toContain('key   = "DEPLOYMENT_ENVIRONMENT"');
    expect(platformBootstrapJob).toContain("value = var.environment");
  });

  it("keeps shared Catalog asset buckets and CDN domains in their own stable root", () => {
    expect(catalogAssetsMain).toContain('resource "digitalocean_spaces_bucket" "catalog_assets"');
    expect(catalogAssetsMain).toContain('acl           = "public-read"');
    expect(catalogAssetsMain).toContain('resource "digitalocean_cdn" "catalog_assets"');
    expect(catalogAssetsMain).toContain('resource "digitalocean_certificate" "catalog_assets_cdn"');
    expect(catalogAssetsMain).not.toContain("digitalocean_record");
    expect(catalogAssetsLocals).toContain('preview    = "chase-sets-preview-catalog-assets"');
    expect(catalogAssetsLocals).toContain('staging    = "assets.staging.${var.root_domain}"');
    expect(catalogAssetsLocals).toContain('production = "assets.${var.root_domain}"');
    expect(platformStagingResetWorkflow).toContain("Verify staging catalog asset CDN");
    expect(platformStagingResetWorkflow).toContain("terraform import digitalocean_cdn.catalog_assets");
    expect(platformStagingResetWorkflow).toContain("doctl compute cdn list --output json");
    expect(platformStagingResetWorkflow).toContain("doctl compute domain records list chasesets.com --output json");
    expect(platformStagingResetWorkflow).toContain('"https://${custom_domain}/" >/dev/null');
    expect(platformProductionWorkflow).toContain("catalog_asset_public_base_url");
    expect(platformProductionWorkflow).toContain('"${catalog_asset_public_base_url}/" >/dev/null');
  });

  it("routes non-production UCP agent discovery and transport paths to platform-api", () => {
    expect(platformLocals).toContain('ucp_route_prefixes   = ["/.well-known", "/ucp"]');
    expect(platformLocals).toContain("ucp_ingress_routes");
    expect(platformMain).toContain("for_each = local.ucp_ingress_routes");
    expect(platformMain).toContain("prefix = rule.value.path_prefix");
    expect(platformMain).toContain('name                 = "platform-api"');
  });

  it("wires Google Workspace SSO into production admin-support API", () => {
    expect(platformMain).toContain('name               = "admin-support-api"');
    expect(occurrenceCount(platformMain, 'key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_ID"')).toBe(3);
    expect(occurrenceCount(platformMain, 'key   = "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET"')).toBe(3);
    expect(occurrenceCount(platformMain, 'key   = "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS"')).toBe(3);
  });

  it("keeps App Platform database and runner budgets explicit by component", () => {
    expectTerraformAssignment(platformLocals, "api_database_pool_max", '"6"');
    expectTerraformAssignment(
      platformLocals,
      "worker_default_database_pool_max",
      "local.is_staging ? 10 : (local.is_non_production ? 8 : 7)",
    );
    expectTerraformAssignment(platformLocals, "worker_database_pool_max", "tostring(var.worker_database_pool_max");
    expectTerraformAssignment(platformLocals, "bootstrap_database_pool_max", '"4"');
    expectTerraformAssignment(platformLocals, "worker_projection_concurrency", '"2"');
    expectTerraformAssignment(platformLocals, "worker_wake_concurrency", 'local.is_staging ? "2" : "1"');
    expectTerraformAssignment(platformLocals, "worker_default_job_concurrency", "local.is_staging ? 4 : 1");
    expectTerraformAssignment(platformLocals, "worker_job_concurrency", "tostring(var.worker_job_concurrency");
    expectTerraformAssignment(platformLocals, "source_observation_bulk_job_lanes", 'local.is_staging ? "4" : "1"');
    expectTerraformAssignment(platformLocals, "source_observation_bulk_workflow_cap", 'local.is_staging ? "4" : "1"');
    expectTerraformAssignment(platformLocals, "source_observation_bulk_job_cap", 'local.is_staging ? "2" : "1"');
    expectTerraformAssignment(platformLocals, "catalog_authoring_bulk_job_lanes", 'local.is_staging ? "3" : "1"');
    expectTerraformAssignment(
      platformLocals,
      "source_observation_integration_job_lanes",
      'local.is_staging ? "4" : "1"',
    );
    expectTerraformAssignment(platformLocals, "inventory_import_batch_job_lanes", 'local.is_staging ? "4" : "1"');
    expectTerraformAssignment(platformLocals, "pricing_recommendation_job_lanes", 'local.is_staging ? "3" : "1"');
    expectTerraformAssignment(
      platformLocals,
      "settlement_payout_reconciliation_job_lanes",
      'local.is_staging ? "2" : "1"',
    );
    expect(platformLocals).toContain("default_worker_instances = local.is_staging ? 2 : 1");
    expect(platformLocals).toContain("worker_instances         = var.worker_instance_count > 0");
    expect(platformVariables).toContain('variable "worker_instance_count"');
    expect(platformVariables).toContain('variable "worker_job_concurrency"');
    expect(platformVariables).toContain('variable "worker_database_pool_max"');
    expect(platformVariables).toContain('default     = "db-s-2vcpu-4gb"');
    expect(platformVariables).toContain('variable "staging_database_size"');
    expect(platformLocals).toContain("local.is_staging ? var.staging_database_size");
    expect(platformLocals).toContain("staging_context_database_connection_pool_sizes");
    expect(platformLocals).toContain("catalog         = 6");
    expect(platformLocals).toContain("control         = 4");
    expect(platformMain).toContain("size       = local.context_database_connection_pool_sizes[each.key]");
    expect(occurrenceCount(platformMain, "value = local.api_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, "value = local.worker_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, "value = local.bootstrap_database_pool_max")).toBe(2);
    expect(occurrenceCount(platformMain, 'key   = "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS"')).toBe(2);
    expect(occurrenceCount(platformMain, 'key   = "SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT"')).toBe(1);
    expect(occurrenceCount(platformMain, 'key   = "SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS"')).toBe(1);
    expect(occurrenceCount(platformMain, 'key   = "SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB"')).toBe(1);
    for (const key of [
      "CATALOG_AUTHORING_BULK_JOB_LANE_COUNT",
      "CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      "CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      "SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT",
      "SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      "SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      "INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT",
      "INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      "INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      "PRICING_RECOMMENDATION_JOB_LANE_COUNT",
      "PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      "PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT",
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS",
      "SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB",
    ]) {
      expect(occurrenceCount(platformMain, `key   = "${key}"`)).toBe(1);
    }
    expect(occurrenceCount(platformMain, 'key   = "WORKER_WAKE_MAX_CONCURRENT_RUNNERS"')).toBe(1);
    expect(platformLocals).toContain(
      'worker_listener_source_contexts = ["checkout", "marketplace", "ordering", "payments"]',
    );
    expect(platformLocals).toContain("worker_listener_database_urls");
    expect(occurrenceCount(platformMain, "for_each = local.worker_listener_database_urls")).toBe(1);
    expect(platformMain).toContain('key   = "WORKER_LISTENER_DATABASE_URL_${upper(replace(env.key, "-", "_"))}"');
    expectTerraformAssignment(
      platformLocals,
      "read_consistency_wake_before_wait_enabled",
      'local.is_staging ? "true" : "false"',
    );
    expect(occurrenceCount(platformMain, 'key   = "READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED"')).toBe(1);
    expectTerraformAssignment(
      platformLocals,
      "worker_projection_wake_relay_enabled",
      'local.is_staging ? "true" : "false"',
    );
    expectTerraformAssignment(
      platformLocals,
      "event_store_wake_notifications_enabled",
      'local.is_staging ? "true" : "false"',
    );
    expect(occurrenceCount(platformMain, 'key   = "WORKER_PROJECTION_WAKE_RELAY_ENABLED"')).toBe(1);
    expect(occurrenceCount(platformMain, 'key   = "PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED"')).toBe(6);
    expect(platformMain).toContain('check "worker_runner_capacity"');
    expect(platformMain).toContain("tonumber(local.worker_job_concurrency)");
    expect(platformMain).toContain("tonumber(local.worker_wake_concurrency)");
    expect(platformMain).toContain(
      'dynamic "worker" {\n      for_each = local.marketplace_platform_enabled ? [1] : []',
    );
    expect(platformMain).not.toMatch(/name\s+= "platform-worker"[\s\S]*?http_port\s+= 8080/);
  });

  it("provisions databases for every platform-api bounded context", () => {
    const managedContexts = terraformStringList(platformLocals, "platform_context_names");
    expect(managedContexts).toEqual(expect.arrayContaining(platformApiContextNames()));
  });

  it("keeps production context database names within DigitalOcean limits", () => {
    const managedContexts = terraformStringList(platformLocals, "platform_context_names");
    const databaseNameOverrides = terraformStringMap(platformLocals, "context_database_name_token_overrides");
    const databaseNames = managedContexts.map((contextName) => {
      const token = databaseNameOverrides[contextName] ?? contextName.replaceAll("-", "_");
      return `chase_sets_production_${token}`;
    });

    expect(platformMain).toContain('check "context_database_name_lengths"');
    expect(databaseNames.filter((databaseName) => databaseName.length > 40)).toEqual([]);
    expect(databaseNames).toContain("chase_sets_production_platform_ops");
  });

  it("routes staging root as the managed primary marketplace host", () => {
    expect(platformLocals).toContain('environment_zone    = "${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain("staging_root_marketplace_domains = local.is_staging");
    expect(platformLocals).toContain('"${var.environment}.${var.root_domain}"');
    expect(platformLocals).toContain(
      "all_marketplace_domains = concat(local.marketplace_domains, local.staging_root_marketplace_domains)",
    );
    expect(platformLocals).toContain(
      "app_primary_domain      = local.is_staging ? local.staging_root_marketplace_domains[0] : local.public_domains[0]",
    );
    expect(platformLocals).toContain(
      "concat(local.public_domains, [local.admin_domain], local.all_marketplace_domains)",
    );
    expect(platformLocals).toContain("for domain in local.all_marketplace_domains");
    expect(platformMain).toContain("for_each = local.staging_root_marketplace_domains");
    expect(platformMain).toContain("for_each = local.all_marketplace_domains");
    expect(platformMain).toContain('type = domain.value == local.app_primary_domain ? "PRIMARY" : "ALIAS"');
    expect(platformLocals).toContain("app_domain_zones = merge(");
    expect(platformLocals).toContain("domain => local.is_staging ? local.environment_zone : var.root_domain");
    expect(platformMain).toContain("zone = local.app_domain_zones[domain.value]");
    expect(platformMain).toContain("zone = local.app_domain_zones[local.admin_domain]");
    expect(platformLocals).toContain("staging_app_alias_record_names");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv4_records");
    expect(platformLocals).not.toContain("staging_root_app_platform_ipv6_records");
    expect(platformMain).toContain('resource "digitalocean_record" "staging_app_alias"');
    expect(platformMain).toContain('type   = "CNAME"');
    expect(platformMain).toContain("digitalocean_app.platform.default_ingress");
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv4"');
    expect(platformMain).not.toContain('resource "digitalocean_record" "staging_root_app_platform_ipv6"');
    expect(platformMain).toContain('name                 = "marketplace"');
    expect(platformMain).toContain('name                 = "platform-api"');
  });

  it("keeps production marketplace promotion explicitly gated", () => {
    expect(platformVariables).toContain('variable "production_marketplace_public_enabled"');
    expect(platformVariables).toContain("production_marketplace_public_enabled may only be true for production.");
    expect(platformVariables).toContain('variable "production_marketplace_launch_evidence_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_launch_evidence_reference must be a real Marketplace Launch Evidence packet reference, not a placeholder.",
    );
    expect(platformVariables).toContain('variable "production_marketplace_proof_enabled"');
    expect(platformVariables).toContain("production_marketplace_proof_enabled may only be true for production.");
    expect(platformVariables).toContain('variable "production_marketplace_proof_reference"');
    expect(platformVariables).toContain(
      "production_marketplace_proof_reference is required when production_marketplace_proof_enabled is true.",
    );
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
    expect(platformVariables).toContain('startswith(var.stripe_secret_key, "sk_live")');
    expect(platformVariables).toContain('startswith(var.stripe_publishable_key, "pk_live")');
    expect(platformVariables).toContain('variable "stripe_connect_webhook_secret"');
    expect(platformVariables).toContain(
      "stripe_connect_webhook_secret is required outside gated landing-only production and during production marketplace proof or promotion.",
    );
    expect(platformMain).toContain('key   = "STRIPE_CONNECT_WEBHOOK_SECRET"');
    expect(platformMain).toContain("value = var.stripe_connect_webhook_secret");
    expect(platformVariables).not.toContain('variable "stripe_connect_return_url"');
    expect(platformVariables).not.toContain('variable "stripe_connect_refresh_url"');
    expect(platformMain).not.toContain('key   = "STRIPE_CONNECT_RETURN_URL"');
    expect(platformMain).not.toContain('key   = "STRIPE_CONNECT_REFRESH_URL"');
    expect(platformVariables).toContain('variable "easypost_webhook_secret"');
    expect(platformVariables).toContain(
      "easypost_webhook_secret is required when production marketplace proof or promotion is enabled.",
    );
    expect(platformVariables).toContain('var.easypost_mode == "production"');
    expect(platformLocals).toContain("marketplace_platform_enabled = (");
    expect(platformLocals).toContain("placeholder_evidence_references = [");
    expect(platformLocals).toContain('"launch-000"');
    expect(platformLocals).toContain("var.production_marketplace_proof_enabled");
    expect(platformLocals).toContain("marketplace_public_enabled = (");
    expect(platformLocals).toContain("local.is_non_production || var.production_marketplace_public_enabled");
    expect(platformLocals).toContain(
      'platform_api_private_url      = local.marketplace_platform_enabled ? "$${platform-api.PRIVATE_URL}" : local.api_private_url',
    );
    expect(platformLocals).toContain(
      "admin_web_internal_api_origin = local.marketplace_platform_enabled ? local.platform_api_private_url : local.api_private_url",
    );
    expect(platformLocals).toContain("production_proof_web_enabled = (");
    expect(platformLocals).toContain("marketplace_web_enabled = (");
    expect(platformLocals).toContain("marketplace_domains = local.marketplace_web_enabled");
    expect(platformLocals).toContain('local.is_production ? "marketplace.${var.root_domain}"');
    expect(platformLocals).toContain("provider_webhook_ingress_routes = {");
    expect(platformLocals).toContain('"/api/payments/provider/webhooks"');
    expect(platformLocals).toContain('"/api/settlement/provider/money-movement/webhooks"');
    expect(platformLocals).toContain("proof_api_ingress_routes = {");
    expect(platformLocals).toContain('"/api/marketplace/account/sales/shipments"');
    expect(platformLocals).toContain('"/api/inventory/items/listing-stock/ensure"');
    expect(platformLocals).toContain('"/api/inventory/storage-locations"');
    expect(platformLocals).toContain('"/api/marketplace/account/listing-availability"');
    expect(platformLocals).toContain('"/api/marketplace/account/listing-inventory"');
    expect(platformLocals).toContain('"/api/marketplace/account/listings"');
    expect(platformLocals).toContain('"/api/marketplace/account/payments"');
    expect(platformLocals).toContain('"/api/settlement/payout-setup"');
    expect(platformLocals).toContain("proof_admin_api_ingress_routes = {");
    expect(platformLocals).toContain('"/api/catalog"');
    expect(platformLocals).toContain('"/api/commercial-terms"');
    expect(platformLocals).toContain('"/api/platform"');
    expect(platformLocals).toContain('"/api/public-presence"');
    expect(platformLocals).toContain('"/api/realtime"');
    expect(platformLocals).toContain("proof_admin_api_route_domains = local.is_production");
    expect(platformLocals).toContain("local.admin_domain");
    expect(platformLocals).toContain("proof_web_ingress_routes = {");
    expect(platformLocals).toContain('"/account/payouts/setup"');
    expect(platformMain).toContain('key   = "CHASE_SETS_MARKETPLACE_PROOF_ACCESS_REQUIRED"');
    expect(platformMain).toContain('key   = "CHASE_SETS_MARKETPLACE_PROOF_ACCESS_PERMISSION"');
    expect(platformMain).toContain('value = "security.manage"');
    const marketplaceService = terraformServiceBlock(platformMain, "marketplace");
    expect(marketplaceService).toContain('key   = "STRIPE_PUBLISHABLE_KEY"');
    expect(marketplaceService).toContain("value = var.stripe_publishable_key");
    expect(marketplaceService).toContain('type  = "SECRET"');
    const adminWebService = terraformServiceBlock(platformMain, "admin-web");
    expect(adminWebService).toContain('key   = "CHASE_SETS_INTERNAL_API_ORIGIN"');
    expect(adminWebService).toContain("value = local.admin_web_internal_api_origin");
    expect(adminWebService).toContain('key   = "CHASE_SETS_MARKETPLACE_ORIGIN"');
    expect(adminWebService).toContain("value = local.marketplace_origin");
    expect(platformLocals).toContain("context_names = local.marketplace_platform_enabled");
    expect(platformMain).toContain('check "production_marketplace_proof"');
    expect(platformMain).toContain(
      'error_message = "Production marketplace proof mode requires a production environment and a real evidence-collection approval reference."',
    );
    expect(platformMain).toContain('check "production_marketplace_promotion"');
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires production environment and complete Amazon SES transactional email configuration."',
    );
    expect(platformMain).toContain('check "production_marketplace_launch_approval"');
    expect(platformMain).toContain("var.production_marketplace_launch_evidence_reference");
    expect(platformMain).toContain("var.production_marketplace_promotion_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved launch evidence and a passing Marketplace Launch Evidence packet reference before deploying the public marketplace."',
    );
    expect(platformMain).toContain('check "production_marketplace_evidence_reference_quality"');
    expect(platformMain).toContain("var.production_transactional_email_reference");
    expect(platformMain).toContain("local.placeholder_evidence_references");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion evidence references must point to real external evidence records, not placeholders."',
    );
    expect(platformMain).toContain('check "production_marketplace_checkout_fee_approval"');
    expect(platformMain).toContain("var.production_marketplace_checkout_fee_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Marketplace Checkout Fee evidence before live checkout."',
    );
    expect(platformMain).toContain('check "production_stripe_money_operations_readiness"');
    expect(platformMain).toContain("var.production_stripe_money_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Stripe money operations evidence before live payments and payouts."',
    );
    expect(platformMain).toContain('check "production_support_operations_readiness"');
    expect(platformMain).toContain("var.production_support_operations_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Support operations evidence before live order support."',
    );
    expect(platformMain).toContain('check "production_fulfillment_postage_readiness"');
    expect(platformMain).toContain("var.production_fulfillment_postage_approved");
    expect(platformMain).toContain(
      'error_message = "Production marketplace promotion requires approved Fulfillment postage evidence before live shipment labels."',
    );
    expect(platformMain).toContain('key   = "EASYPOST_WEBHOOK_SECRET"');
    expect(platformMain).toContain("value = var.easypost_webhook_secret");
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
    expect(platformMain).toContain("for_each = local.marketplace_platform_enabled ? [1] : []");
    expect(platformMain).toContain("for_each = local.marketplace_web_enabled ? [1] : []");
    expect(platformMain).toContain("for_each = local.marketplace_public_enabled ? [] : [1]");
    expect(platformMain).toContain("for_each = local.provider_webhook_ingress_routes");
    expect(platformMain).toContain("for_each = local.proof_api_ingress_routes");
    expect(platformMain).toContain("for_each = local.proof_admin_api_ingress_routes");
    expect(platformMain).toContain("for_each = local.proof_web_ingress_routes");
    expect(platformMain).toContain(
      'value = local.is_production && local.marketplace_public_enabled ? "true" : "false"',
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_public_enabled: ${{ vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain("pull-requests: read");
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
    expect(platformProductionWorkflow).toContain("started_at: ${{ steps.staging_started.outputs.started_at }}");
    expect(platformProductionWorkflow).toContain("completed_at: ${{ steps.staging_completed.outputs.completed_at }}");
    expect(platformProductionWorkflow).toContain("- name: Record staging start");
    expect(platformProductionWorkflow).toContain("- name: Record staging completion");
    expect(platformProductionWorkflow).toContain("- name: Record production start");
    expect(platformProductionWorkflow).toContain("- name: Evaluate production release lock");
    expect(platformProductionWorkflow).toContain("RELEASE_COMMIT: ${{ needs.resolve-release.outputs.release_commit }}");
    expect(platformProductionWorkflow).toContain(
      "EMERGENCY_RELEASE_BYPASS: ${{ github.event_name == 'workflow_dispatch' && inputs.emergency_release == true && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "EMERGENCY_RELEASE_REFERENCE: ${{ github.event_name == 'workflow_dispatch' && inputs.emergency_reference || '' }}",
    );
    expect(platformProductionWorkflow).toContain("run: node ./scripts/release-lock.mjs");
    expect(platformProductionWorkflow.indexOf("- name: Evaluate production release lock")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Validate production configuration"),
    );
    expect(platformProductionWorkflow).toContain("- name: Resolve release health metadata");
    expect(platformProductionWorkflow).toContain("SOURCE_WORKFLOW_CREATED_AT");
    expect(platformProductionWorkflow).toContain("node ./scripts/release-health-github-metadata.mjs");
    expect(platformProductionWorkflow).toContain('--release-commit "$release_commit"');
    expect(platformProductionWorkflow).toContain('echo "queue_merge_group_started_at="');
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
      "if: always() && needs.resolve-release.outputs.deployment_required == 'true' && needs.deploy-staging.outputs.deployed != 'true'",
    );
    expect(platformProductionWorkflow).toContain("RELEASE_HEALTH_OUT: artifacts/release-health/staging-release.json");
    expect(platformProductionWorkflow).toContain("- name: Resolve staging CI retry metadata");
    expect(platformProductionWorkflow).toContain("STAGING_JOB_RESULT: ${{ needs.deploy-staging.result }}");
    expect(platformProductionWorkflow).toContain('RELEASE_ATTEMPT_PHASE="staging"');
    expect(platformProductionWorkflow).toContain("name: staging-release-health");
    expect(platformProductionWorkflow).toContain("- name: Stage 1 production canary");
    expect(platformProductionWorkflow.indexOf("- name: Stage 1 production canary")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Collect production canary observability evidence"),
    );
    expect(platformProductionWorkflow.indexOf("- name: Collect production canary observability evidence")).toBeLessThan(
      platformProductionWorkflow.indexOf("- name: Mark production release"),
    );
    expect(platformProductionWorkflow).toContain("CANARY_PROMETHEUS_URL: ${{ vars.CANARY_PROMETHEUS_URL || '' }}");
    expect(platformProductionWorkflow).toContain(
      "CANARY_PROMETHEUS_QUERY_FILE: ${{ vars.CANARY_PROMETHEUS_QUERY_FILE || '' }}",
    );
    expect(platformProductionWorkflow).toContain("run: node ./scripts/canary-evidence.mjs");
    expect(platformProductionWorkflow).toContain("- name: Resolve CI retry metadata");
    expect(platformProductionWorkflow).toContain("node ./scripts/release-health-ci-metadata.mjs");
    expect(platformProductionWorkflow).toContain("CI_RETRY_COUNT: ${{ steps.ci_metadata.outputs.ci_retry_count }}");
    expect(platformProductionWorkflow).toContain(
      "CANARY_RESULT: ${{ steps.canary_evidence.outcome == 'failure' && 'failure' || steps.stage1_canary.outcome || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain("CANARY_STARTED_AT: ${{ steps.stage1_canary.outputs.started_at }}");
    expect(platformProductionWorkflow).toContain(
      "CANARY_PROMOTION_DECISION: ${{ steps.canary_evidence.outcome == 'failure' && 'abort' || steps.stage1_canary.outcome == 'success' && 'promote' || steps.stage1_canary.outcome == 'failure' && 'abort' || 'skipped' }}",
    );
    expect(platformProductionWorkflow).toContain("PRODUCTION_RESULT: ${{ job.status }}");
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
    expect(platformProductionWorkflow).toContain("artifacts/release-health/canary-analysis.json");
    expect(platformProductionWorkflow).toContain("retention-days: 30");
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_launch_evidence_reference: ${{ vars.PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_proof_enabled: ${{ vars.PRODUCTION_MARKETPLACE_PROOF_ENABLED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_marketplace_proof_reference: ${{ vars.PRODUCTION_MARKETPLACE_PROOF_REFERENCE || '' }}",
    );
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
      "TF_VAR_production_stripe_money_operations_approved: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED == 'true' && 'true' || 'false' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_production_stripe_money_operations_reference: ${{ vars.PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_stripe_connect_webhook_secret: ${{ (vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true' || vars.PRODUCTION_MARKETPLACE_PROOF_ENABLED == 'true') && secrets.STRIPE_CONNECT_WEBHOOK_SECRET || '' }}",
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
      "TF_VAR_easypost_webhook_secret: ${{ (vars.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED == 'true' || vars.PRODUCTION_MARKETPLACE_PROOF_ENABLED == 'true') && secrets.EASYPOST_WEBHOOK_SECRET || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_google_social_login_client_id: ${{ secrets.GOOGLE_SOCIAL_LOGIN_CLIENT_ID || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_google_social_login_client_secret: ${{ secrets.GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET || '' }}",
    );
    expect(platformProductionWorkflow).toContain(
      "TF_VAR_admin_google_workspace_hosted_domains: ${{ vars.ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS || '' }}",
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
      "Production marketplace platform deployment requires Stripe live-mode keys.",
    );
    expect(platformProductionWorkflow).toContain("Missing required production marketplace platform configuration");
    expect(platformProductionWorkflow).toContain(
      "Production marketplace platform deployment requires EASYPOST_MODE=production.",
    );
    expect(platformProductionWorkflow).toContain("Missing required production Google Workspace SSO configuration");
    expect(platformProductionWorkflow).toContain(
      "Production marketplace proof mode requires an evidence-collection approval reference.",
    );
    expect(platformProductionWorkflow).toContain("Production marketplace promotion requires approved launch evidence.");
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires a Marketplace Launch Evidence packet reference.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires a real Marketplace Launch Evidence packet reference, not a placeholder.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Marketplace Checkout Fee evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Stripe money operations evidence.",
    );
    expect(platformProductionWorkflow).toContain(
      "Production marketplace promotion requires approved Support operations evidence.",
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
    expect(platformProductionWorkflow).toContain('export SMOKE_REQUIRE_MARKETPLACE="true"');
  });

  it("keeps admin-web API dependency inventory aligned with local proxy and proof ingress", () => {
    const localProxyPrefixes = viteProxyPrefixes();
    const proofAdminApiPrefixes = terraformStringList(platformLocals, "proof_admin_api_route_prefixes");

    expect(ADMIN_WEB_API_DEPENDENCIES.map((dependency) => dependency.callerType)).toEqual(
      expect.arrayContaining(["server-loader/action", "direct-download", "event-source", "durable-job-event-source"]),
    );

    const missingIds = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !dependency.id || !dependency.smokeCoverageId,
    ).map((dependency) => dependency.surface);
    expect(missingIds).toEqual([]);

    const missingTopologyModes = ADMIN_WEB_API_DEPENDENCIES.filter((dependency) =>
      ["staging", "production-proof", "public-marketplace", "production-platform-disabled"].some(
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

    const missingProofIngress = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) =>
        dependency.proofAdminIngressPrefix && !proofAdminApiPrefixes.includes(dependency.proofAdminIngressPrefix),
    ).map(
      (dependency) =>
        `${dependency.surface} (${dependency.callerType}) from ${dependency.sourceFile} requires ${dependency.proofAdminIngressPrefix} for ${dependency.apiPath}`,
    );
    expect(missingProofIngress).toEqual([]);
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

  it("delegates staging DNS so App Platform apex routing can coexist with mail records", () => {
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
    expect(platformProductionWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformStagingResetWorkflow).toContain("Terraform apply staging environment DNS");
    expect(platformProductionWorkflow).toContain("Reconcile staging App Platform alias DNS state");
    expect(platformProductionWorkflow).toContain('doctl apps get "$app_id" --format DefaultIngress --no-header');
    expect(platformProductionWorkflow).toContain("TF_VAR_platform_internal_auth_secret");
    expect(platformProductionWorkflow).toContain('terraform import "$address" "${zone},${record_id}"');
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_digitalocean_token",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_platform_admin_password",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_stripe_secret_key",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_easypost_api_key",
    );
    expect(workflowStep(platformProductionWorkflow, "Reconcile staging App Platform alias DNS state")).toContain(
      "TF_VAR_easypost_webhook_secret",
    );
    expect(platformStagingResetWorkflow).toContain("Reconcile staging App Platform alias DNS state");
    expect(platformStagingResetWorkflow).toContain('doctl apps get "$app_id" --format DefaultIngress --no-header');
    expect(platformStagingResetWorkflow).toContain("TF_VAR_platform_internal_auth_secret");
    expect(platformStagingResetWorkflow).toContain('terraform import "$address" "${zone},${record_id}"');
    expect(platformProductionWorkflow).toContain("Reset stale staging root domain attachment");
    expect(platformProductionWorkflow).toContain('reset-domain "$app_id" staging.chasesets.com');
    expect(platformStagingResetWorkflow).toContain("Reset stale staging root domain attachment");
    expect(platformStagingResetWorkflow).toContain('reset-domain "$app_id" staging.chasesets.com');
  });

  it("splits app and data regions and manages uptime checks", () => {
    expect(platformVariables).toContain('variable "app_region"');
    expect(platformVariables).toContain('default     = "nyc"');
    expect(platformVariables).toContain('variable "data_region"');
    expect(platformVariables).toContain('default     = "nyc3"');
    expect(platformMain).toContain("region     = var.data_region");
    expect(platformMain).toContain("region = var.app_region");
    expect(platformMain).toContain('resource "digitalocean_uptime_check" "platform"');
    expect(platformMain).toContain('resource "digitalocean_uptime_alert" "platform_down"');
    expect(platformLocals).toContain("uptime_check_targets = merge(");
    expect(platformLocals).toContain("realtime_stream_limiter");
    expect(platformMain).toContain('check "api_realtime_coordination"');
  });

  it("keeps representative commerce refresh as an explicit staging-only operator workflow", () => {
    expect(platformRepresentativeWorkflow).toContain("environment: staging");
    expect(platformRepresentativeWorkflow).toContain("seed staging commerce");
    expect(platformRepresentativeWorkflow).toContain("DEPLOYMENT_ENVIRONMENT: staging");
    expect(platformRepresentativeWorkflow).toContain("REPRESENTATIVE_COMMERCE_STATE_CATALOG_ITEM_LIMIT");
    expect(platformRepresentativeWorkflow).toContain("REPRESENTATIVE_COMMERCE_STATE_STEP_TIMEOUT_MS");
    expect(platformRepresentativeWorkflow).toContain('default: "300000"');
    expect(platformRepresentativeWorkflow).toContain("terraform state pull");
    expect(platformRepresentativeWorkflow).toContain("digitalocean_database_cluster");
    expect(platformRepresentativeWorkflow).toContain("digitalocean_database_db");
    expect(platformRepresentativeWorkflow).toContain("digitalocean_database_user");
    expect(platformRepresentativeWorkflow).toContain("Direct database state is incomplete");
    expect(platformRepresentativeWorkflow).toContain("PLATFORM_CONTROL_DATABASE_URL");
    expect(platformRepresentativeWorkflow).toContain("DATABASE_URL_${String(contextName).toUpperCase()");
    expect(platformRepresentativeWorkflow).toContain("MARKETPLACE_LISTING_PHOTO_STORAGE_KIND: s3");
    expect(platformRepresentativeWorkflow).toContain(
      "pnpm --filter @chase-sets/app-platform-api run representative-commerce-state:production",
    );
    expect(platformProductionWorkflow).not.toContain("representative-commerce-state:production");
  });

  it("gates production promotion on staging marketplace critical flows", () => {
    const stagingCriticalFlowStep = workflowStep(platformProductionWorkflow, "Staging marketplace critical flows");
    const stagingGuestBuyNowCanaryStep = workflowStep(
      platformProductionWorkflow,
      "Staging guest Buy Now freshness canary",
    );
    const stagingGuestBuyNowEvidenceStep = workflowStep(
      platformProductionWorkflow,
      "Upload staging guest Buy Now canary evidence",
    );
    const stagingMoneySmokeStep = workflowStep(platformProductionWorkflow, "Staging Stripe money smoke");
    const markStagingDeployedIndex = platformProductionWorkflow.indexOf("- name: Mark staging deployed");

    expect(platformProductionWorkflow).toContain("Install Playwright Chromium for staging critical flows");
    expect(stagingCriticalFlowStep).toContain("PLAYWRIGHT_SKIP_WEB_SERVER");
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
    expect(stagingGuestBuyNowCanaryStep).toContain("GUEST_BUY_NOW_CANARY_SEARCH_QUERY");
    expect(stagingGuestBuyNowCanaryStep).toContain("vars.STAGING_GUEST_BUY_NOW_CANARY_SEARCH_QUERY");
    expect(stagingGuestBuyNowCanaryStep).toContain("vars.MARKETPLACE_E2E_SEARCH_QUERY");
    expect(stagingGuestBuyNowCanaryStep).toContain("--search-query");
    expect(stagingGuestBuyNowCanaryStep).toContain("GUEST_BUY_NOW_CANARY_ITEM_PATH");
    expect(stagingGuestBuyNowCanaryStep).toContain('canary_args+=(--item-path "${GUEST_BUY_NOW_CANARY_ITEM_PATH}")');
    expect(stagingGuestBuyNowCanaryStep).toContain("pnpm run guest-buy-now:freshness-canary");
    expect(stagingGuestBuyNowEvidenceStep).toContain(
      "if: always() && steps.latest_main.outputs.should_deploy != 'false'",
    );
    expect(stagingGuestBuyNowEvidenceStep).toContain("staging-guest-buy-now-freshness-canary");

    expect(stagingMoneySmokeStep).toContain("AWS_ACCESS_KEY_ID");
    expect(stagingMoneySmokeStep).toContain("AWS_SECRET_ACCESS_KEY");
    expect(stagingMoneySmokeStep).toContain("SMOKE_REGISTER_SELLER");
    expect(stagingMoneySmokeStep).toContain(
      "SMOKE_SELLER_DISPLAY_NAME: Stripe Staging Smoke ${{ github.run_id }}-${{ github.run_attempt }}",
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
    expect(platformPrWorkflow).toContain("STRIPE_MONEY_SMOKE_ENVIRONMENT: preview");
    expect(platformPrWorkflow).toContain('STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS: "false"');

    expect(platformProductionWorkflow.indexOf("- name: Staging marketplace critical flows")).toBeLessThan(
      markStagingDeployedIndex,
    );
    expect(platformProductionWorkflow.indexOf("- name: Staging Stripe money smoke")).toBeLessThan(
      markStagingDeployedIndex,
    );
  });
});
